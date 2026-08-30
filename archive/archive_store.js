const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  archiveContent,
  contentFingerprint,
  messageIdentity,
  sanitizeArchiveJson
} = require("./archive_content");

// Stable, project-specific lock key. pg_advisory_xact_lock releases it with
// the migration transaction, including every rollback path.
const MIGRATION_ADVISORY_LOCK_KEY = 84391309421;

function archiveError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function asIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw archiveError("ARCHIVE_VALIDATION", "time is invalid");
  return date.toISOString();
}

function normalizeMessageTime(value) {
  if (value == null || value === "") return null;
  return asIso(value);
}

function normalizeIdentifier(value, { field, required = false, maxLength = 128 } = {}) {
  if (value == null) {
    if (required) throw archiveError("ARCHIVE_VALIDATION", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw archiveError("ARCHIVE_VALIDATION", `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw archiveError("ARCHIVE_VALIDATION", `${field} is required`);
    return null;
  }
  if (normalized.length > maxLength || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw archiveError("ARCHIVE_VALIDATION", `${field} is invalid`);
  }
  return normalized;
}

function normalizeRole(value) {
  if (!["user", "assistant"].includes(value)) throw archiveError("ARCHIVE_VALIDATION", "role is invalid");
  return value;
}

function normalizeStatus(value, fallback) {
  const result = String(value || fallback || "pending");
  if (![
    "direct", "seeded", "reconciled", "conflict", "possible_retry",
    "ambiguous_overlap", "resolved_distinct", "resolved_duplicate", "pending"
  ].includes(result)) {
    throw archiveError("ARCHIVE_VALIDATION", "reconcile_status is invalid");
  }
  return result;
}

function normalizeCompletionStatus(value, fallback = "not_applicable") {
  const result = String(value || fallback);
  if (!["complete", "partial", "failed", "unknown", "not_applicable"].includes(result)) {
    throw archiveError("ARCHIVE_VALIDATION", "completion_status is invalid");
  }
  return result;
}

function normalizeDeliveryStatus(value, fallback = "unknown") {
  const result = String(value || fallback);
  if (!["delivered", "unconfirmed", "unknown", "not_applicable"].includes(result)) {
    throw archiveError("ARCHIVE_VALIDATION", "delivery_status is invalid");
  }
  return result;
}

function identityEquals(left, right) {
  return left?.role === right?.role && left?.fingerprint === right?.fingerprint;
}

function sequenceEquals(left, right) {
  return left.length === right.length && left.every((message, index) => identityEquals(message, right[index]));
}

// Context can advance canonical history only when the retained tail provides
// one substantial, unique suffix/prefix alignment. Anything weaker is evidence
// for a conflict but must not decide sequence continuation.
function resolveRollingOverlap(tail, visible) {
  const maximum = Math.min(tail.length, visible.length);
  const matches = [];
  for (let size = maximum; size >= 2; size -= 1) {
    if (sequenceEquals(tail.slice(-size), visible.slice(0, size))) matches.push(size);
  }
  if (matches.length === 0) return { kind: "NONE", size: 0, matches: [] };

  const size = matches[0];
  const coverage = visible.length === 0 ? 0 : size / visible.length;
  const prefix = visible.slice(0, size);
  let occurrences = 0;
  for (let index = 0; index + size <= tail.length; index += 1) {
    if (sequenceEquals(tail.slice(index, index + size), prefix)) occurrences += 1;
  }
  const sufficientlyCovered = size === visible.length || coverage >= 0.75;
  if (matches.length === 1 && occurrences === 1 && size >= 3 && sufficientlyCovered) {
    return { kind: "RELIABLE", size, matches, coverage };
  }
  return { kind: "AMBIGUOUS", size, matches, coverage, occurrences };
}

function requestKey({ conversationId, assistantId, predecessorSequence, requestContextHash }) {
  return sha256(JSON.stringify({
    version: 2,
    conversation_id: conversationId,
    assistant_id: assistantId || null,
    predecessor_sequence: predecessorSequence || 0,
    request_context_hash: requestContextHash
  }));
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

class ArchiveStore {
  constructor({
    pool,
    migrationsDirectory = path.join(__dirname, "..", "migrations"),
    now = () => new Date(),
    migrationLock = null
  } = {}) {
    if (!pool || typeof pool.connect !== "function") throw new Error("ArchiveStore requires a PostgreSQL pool");
    this.pool = pool;
    this.migrationsDirectory = migrationsDirectory;
    this.now = now;
    this.migrationLock = migrationLock;
    this.migrated = false;
    this.migrationPromise = null;
    this.turnQueues = new Map();
  }

  async migrate() {
    if (this.migrated) return;
    if (this.migrationPromise) return this.migrationPromise;
    this.migrationPromise = this._migrate();
    try {
      await this.migrationPromise;
    } finally {
      this.migrationPromise = null;
    }
  }

  async _acquireMigrationLock(client) {
    if (this.migrationLock) return this.migrationLock(client, MIGRATION_ADVISORY_LOCK_KEY);
    return client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  }

  async _migrate() {
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await this._acquireMigrationLock(client);
      await client.query("CREATE TABLE IF NOT EXISTS archive_schema_migrations (migration_name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)");
      const applied = await client.query("SELECT migration_name FROM archive_schema_migrations");
      const names = new Set(applied.rows.map(row => row.migration_name));
      const files = fs.readdirSync(this.migrationsDirectory).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
      for (const file of files) {
        if (names.has(file)) continue;
        const sql = fs.readFileSync(path.join(this.migrationsDirectory, file), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO archive_schema_migrations (migration_name, applied_at) VALUES ($1, $2)", [file, this.now().toISOString()]);
      }
      await client.query("COMMIT");
      this.migrated = true;
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      error.archive_migration = true;
      throw error;
    } finally {
      client?.release();
    }
  }

  async close() {
    if (this.pool?.end) await this.pool.end();
  }

  async _transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  _runForTurn(turnId, operation) {
    const previous = this.turnQueues.get(turnId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.turnQueues.set(turnId, current);
    const clear = () => {
      if (this.turnQueues.get(turnId) === current) this.turnQueues.delete(turnId);
    };
    current.then(clear, clear);
    return current;
  }

  async _allocateSequence(client, conversationId) {
    const result = await client.query(
      "UPDATE archive_conversations SET next_sequence = next_sequence + 1, updated_at = NOW() WHERE conversation_id = $1 RETURNING next_sequence - 1 AS sequence",
      [conversationId]
    );
    if (!result.rows[0]) throw archiveError("ARCHIVE_CONVERSATION_NOT_FOUND", "conversation is missing");
    return Number(result.rows[0].sequence);
  }

  async _lockConversation(client, conversationId) {
    await client.query(
      "INSERT INTO archive_conversations (conversation_id, next_sequence) VALUES ($1, 1) ON CONFLICT (conversation_id) DO NOTHING",
      [conversationId]
    );
    await client.query("SELECT conversation_id FROM archive_conversations WHERE conversation_id = $1 FOR UPDATE", [conversationId]);
  }

  async _insertMessage(client, input) {
    const role = normalizeRole(input.role);
    const initialContent = archiveContent(input.content);
    const content = input.content_json === undefined
      ? initialContent
      : {
          content_text: input.content_text == null ? initialContent.content_text : String(input.content_text),
          content_json: sanitizeArchiveJson(input.content_json)
        };
    const archiveMessageId = input.archive_message_id || crypto.randomUUID();
    const sequence = await this._allocateSequence(client, input.conversation_id);
    const fingerprint = input.fingerprint || contentFingerprint(role, content.content_json);
    const result = await client.query(
      `INSERT INTO archive_messages (
        archive_message_id, conversation_id, assistant_id, turn_id, role, content_text, content_json,
        source, message_time, observed_at, sequence, fingerprint, turn_key,
        external_event_id, canonical, confirmed, completion_status, delivery_status,
        reconcile_status, metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20::jsonb
      ) RETURNING id, archive_message_id, sequence`,
      [
        archiveMessageId,
        input.conversation_id,
        input.assistant_id || null,
        input.turn_id || null,
        role,
        content.content_text,
        JSON.stringify(content.content_json),
        input.source,
        normalizeMessageTime(input.message_time),
        asIso(input.observed_at || this.now()),
        sequence,
        fingerprint,
        input.turn_key || null,
        input.external_event_id || null,
        input.canonical !== false,
        Boolean(input.confirmed),
        normalizeCompletionStatus(input.completion_status, role === "assistant" ? "unknown" : "not_applicable"),
        normalizeDeliveryStatus(input.delivery_status, role === "assistant" ? "unknown" : "not_applicable"),
        normalizeStatus(input.reconcile_status, "pending"),
        JSON.stringify(sanitizeArchiveJson(input.metadata_json || {}))
      ]
    );
    return result.rows[0];
  }

  async _tail(client, conversationId, limit = 80) {
    const result = await client.query(
      "SELECT id, archive_message_id, role, fingerprint, sequence FROM archive_messages WHERE conversation_id = $1 AND canonical = TRUE ORDER BY sequence DESC, id DESC LIMIT $2",
      [conversationId, limit]
    );
    return result.rows.reverse();
  }

  async _recordConflict(client, {
    conversationId,
    requestContextHash,
    reason,
    observedAt,
    candidateTurnId = null,
    relatedTurnId = null,
    metadata = {}
  }) {
    await client.query(
      `INSERT INTO archive_reconciliation_conflicts (
        conflict_id, conversation_id, request_context_hash, candidate_turn_id, related_turn_id,
        reason, status, observed_at, metadata_json
      ) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8::jsonb)`,
      [
        crypto.randomUUID(), conversationId, requestContextHash, candidateTurnId,
        relatedTurnId, reason, asIso(observedAt || this.now()),
        JSON.stringify(sanitizeArchiveJson(metadata))
      ]
    );
  }

  async _findByClientRequestId(client, conversationId, clientRequestId) {
    if (!clientRequestId) return null;
    const result = await client.query(
      "SELECT turn_id, status, assistant_archive_message_id, client_request_id, client_user_message_id FROM archive_turns WHERE conversation_id = $1 AND client_request_id = $2 ORDER BY started_at DESC LIMIT 1",
      [conversationId, clientRequestId]
    );
    return result.rows[0] || null;
  }

  async _findByClientUserMessageId(client, conversationId, clientUserMessageId) {
    if (!clientUserMessageId) return null;
    const result = await client.query(
      "SELECT turn_id, status, assistant_archive_message_id, client_request_id, client_user_message_id FROM archive_turns WHERE conversation_id = $1 AND client_user_message_id = $2 ORDER BY started_at DESC LIMIT 1",
      [conversationId, clientUserMessageId]
    );
    return result.rows[0] || null;
  }

  async captureIncomingTurn(input) {
    await this.migrate();
    const conversationId = normalizeIdentifier(input.conversation_id, { field: "conversation_id", required: true });
    const assistantId = normalizeIdentifier(input.assistant_id, { field: "assistant_id" });
    const clientRequestId = normalizeIdentifier(input.client_request_id, { field: "client_request_id", required: true });
    const clientUserMessageId = normalizeIdentifier(input.client_user_message_id, { field: "client_user_message_id", required: true });
    const protocolVersion = Number(input.archive_protocol_version);
    if (protocolVersion !== 1 || input.identity_status !== "verified") {
      throw archiveError("ARCHIVE_VALIDATION", "protocol identity is invalid");
    }
    const rootRequestId = normalizeIdentifier(input.root_request_id, { field: "root_request_id", required: true });
    if (rootRequestId !== clientRequestId) throw archiveError("ARCHIVE_VALIDATION", "root_request_id must equal client_request_id");
    const clientUserMessageTime = asIso(input.client_user_message_time);
    const observedAt = asIso(input.observed_at || this.now());
    const latestUser = input.latest_user;
    if (!latestUser || latestUser.role !== "user") throw archiveError("ARCHIVE_VALIDATION", "latest_user is invalid");
    const requestContextHash = String(input.request_context_hash || "");
    if (!/^[0-9a-f]{64}$/i.test(requestContextHash)) throw archiveError("ARCHIVE_VALIDATION", "request_context_hash is invalid");

    return this._transaction(async client => {
      await this._lockConversation(client, conversationId);
      const byRequest = await this._findByClientRequestId(client, conversationId, clientRequestId);
      const byMessage = await this._findByClientUserMessageId(client, conversationId, clientUserMessageId);
      if (byRequest && byMessage && byRequest.turn_id === byMessage.turn_id) {
        return { turn_id: byRequest.turn_id, deduped: true, deterministic_retry: true, status: byRequest.status };
      }
      if (byRequest || byMessage) {
        const related = byRequest || byMessage;
        const reason = byRequest
          ? "request_id_reused_with_different_user_message_id"
          : "user_message_id_reused_with_different_request_id";
        await this._recordConflict(client, {
          conversationId,
          requestContextHash,
          reason,
          observedAt,
          relatedTurnId: related.turn_id,
          metadata: {
            incoming_identity: { client_request_id: clientRequestId, client_user_message_id: clientUserMessageId },
            existing_identity: {
              client_request_id: related.client_request_id,
              client_user_message_id: related.client_user_message_id
            }
          }
        });
        return { skipped: true, event: "archive_identity_conflict", reason };
      }

      const tail = await this._tail(client, conversationId);
      const predecessorSequence = tail.at(-1)?.sequence || 0;
      const turnKey = requestKey({ conversationId, assistantId, predecessorSequence, requestContextHash });
      const turnId = crypto.randomUUID();
      await client.query(
        `INSERT INTO archive_turns (
          turn_id, conversation_id, assistant_id, client_request_id, client_user_message_id,
          archive_protocol_version, identity_status, root_request_id, client_user_message_time,
          request_key, request_context_hash, predecessor_sequence, status, canonical, started_at, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_assistant', TRUE, $13, $14::jsonb)`,
        [turnId, conversationId, assistantId, clientRequestId, clientUserMessageId, protocolVersion, "verified", rootRequestId, clientUserMessageTime, turnKey, requestContextHash, predecessorSequence || null, observedAt, JSON.stringify({})]
      );
      const user = await this._insertMessage(client, {
        conversation_id: conversationId,
        assistant_id: assistantId,
        turn_id: turnId,
        role: "user",
        content: latestUser.content,
        source: "kelivo_live_user",
        message_time: clientUserMessageTime,
        observed_at: observedAt,
        confirmed: true,
        reconcile_status: "direct",
        turn_key: turnKey,
        metadata_json: {
          archive_protocol_version: protocolVersion,
          identity_status: "verified",
          client_request_id_present: Boolean(clientRequestId),
          client_user_message_id: clientUserMessageId
        }
      });
      await client.query("UPDATE archive_turns SET user_archive_message_id = $1 WHERE turn_id = $2", [user.archive_message_id, turnId]);

      return { turn_id: turnId, user_archive_message_id: user.archive_message_id, deduped: false, status: "awaiting_assistant" };
    });
  }

  async captureContinuation(input) {
    await this.migrate();
    const conversationId = normalizeIdentifier(input.conversation_id, { field: "conversation_id", required: true });
    const rootRequestId = normalizeIdentifier(input.root_request_id, { field: "root_request_id", required: true });
    const requestId = normalizeIdentifier(input.client_request_id, { field: "client_request_id", required: true });
    const observedAt = asIso(input.observed_at || this.now());
    if (Number(input.archive_protocol_version) !== 1 || rootRequestId !== requestId) {
      throw archiveError("ARCHIVE_VALIDATION", "continuation identity is invalid");
    }
    return this._transaction(async client => {
      await this._lockConversation(client, conversationId);
      const turn = await this._findByClientRequestId(client, conversationId, rootRequestId);
      if (turn?.client_user_message_id) return { turn_id: turn.turn_id, deduped: true, status: turn.status };
      await this._recordConflict(client, {
        conversationId,
        requestContextHash: sha256(`continuation:${rootRequestId}`),
        reason: "continuation_root_turn_not_found",
        observedAt,
        metadata: { incoming_identity: { root_request_id: rootRequestId } }
      });
      return { skipped: true, event: "archive_identity_conflict", reason: "continuation_root_turn_not_found" };
    });
  }

  async captureAssistantForTurn(input) {
    return this._runForTurn(String(input?.turn_id || ""), () => this._captureAssistantForTurnLocked(input));
  }

  async captureAssistantPhaseForTurn({ turn_id, content, content_text, content_json, observed_at, metadata_json = {} }) {
    await this.migrate();
    const observedAt = asIso(observed_at || this.now());
    return this._transaction(async client => {
      const turnResult = await client.query("SELECT * FROM archive_turns WHERE turn_id = $1 FOR UPDATE", [turn_id]);
      const turn = turnResult.rows[0];
      if (!turn) throw archiveError("ARCHIVE_TURN_NOT_FOUND", "archive turn was not found");
      const phase = await this._insertMessage(client, {
        conversation_id: turn.conversation_id,
        assistant_id: turn.assistant_id,
        turn_id,
        role: "assistant",
        content,
        content_text,
        content_json,
        source: "gateway_assistant_tool_phase",
        message_time: observedAt,
        observed_at: observedAt,
        canonical: false,
        confirmed: true,
        completion_status: "complete",
        delivery_status: "unknown",
        reconcile_status: "direct",
        turn_key: turn.request_key,
        metadata_json
      });
      return { turn_id, archive_message_id: phase.archive_message_id, phase: true, deduped: false };
    });
  }

  async _captureAssistantForTurnLocked({
    turn_id,
    content,
    content_text,
    content_json,
    observed_at,
    metadata_json = {},
    completion_status = "complete",
    confirmed = completion_status === "complete",
    delivery_status = "unknown"
  }) {
    await this.migrate();
    const observedAt = asIso(observed_at || this.now());
    const completionStatus = normalizeCompletionStatus(completion_status, "complete");
    try {
      return await this._transaction(async client => {
      const turnResult = await client.query("SELECT * FROM archive_turns WHERE turn_id = $1 FOR UPDATE", [turn_id]);
      const turn = turnResult.rows[0];
      if (!turn) throw archiveError("ARCHIVE_TURN_NOT_FOUND", "archive turn was not found");
      if (turn.assistant_archive_message_id) {
        return { deduped: true, turn_id, archive_message_id: turn.assistant_archive_message_id, status: turn.status };
      }
      const assistant = await this._insertMessage(client, {
        conversation_id: turn.conversation_id,
        assistant_id: turn.assistant_id,
        turn_id,
        role: "assistant",
        content,
        content_text,
        content_json,
        source: "gateway_assistant",
        message_time: observedAt,
        observed_at: observedAt,
        confirmed: Boolean(confirmed) && completionStatus === "complete",
        completion_status: completionStatus,
        delivery_status,
        reconcile_status: "direct",
        turn_key: turn.request_key,
        metadata_json
      });
      const turnStatus = completionStatus === "complete" ? "assistant_complete" : "assistant_partial";
      await client.query(
        "UPDATE archive_turns SET assistant_archive_message_id = $1, status = $2, completed_at = $3 WHERE turn_id = $4",
        [assistant.archive_message_id, turnStatus, observedAt, turn_id]
      );
      return { turn_id, archive_message_id: assistant.archive_message_id, deduped: false, status: turnStatus };
      });
    } catch (error) {
      // The row lock is the normal cross-instance path. The unique index is a
      // second database defence; if it wins a race, expose the canonical row
      // instead of surfacing a harmless duplicate completion to the gateway.
      if (error?.code === "23505") {
        const existing = await this.pool.query("SELECT assistant_archive_message_id, status FROM archive_turns WHERE turn_id = $1", [turn_id]);
        if (existing.rows[0]?.assistant_archive_message_id) {
          return {
            deduped: true,
            turn_id,
            archive_message_id: existing.rows[0].assistant_archive_message_id,
            status: existing.rows[0].status
          };
        }
      }
      throw error;
    }
  }

  async markAssistantTerminal({ turn_id, observed_at, status = "assistant_interrupted", metadata_json = {} }) {
    await this.migrate();
    const observedAt = asIso(observed_at || this.now());
    return this._transaction(async client => {
      const result = await client.query("SELECT * FROM archive_turns WHERE turn_id = $1 FOR UPDATE", [turn_id]);
      const turn = result.rows[0];
      if (!turn) throw archiveError("ARCHIVE_TURN_NOT_FOUND", "archive turn was not found");
      if (turn.assistant_archive_message_id) return { deduped: true, turn_id, status: turn.status };
      const metadata = { ...parseJson(turn.metadata_json), termination: sanitizeArchiveJson(metadata_json) };
      await client.query("UPDATE archive_turns SET status = $1, completed_at = $2, metadata_json = $3::jsonb WHERE turn_id = $4", [status, observedAt, JSON.stringify(metadata), turn_id]);
      return { turn_id, deduped: false, status };
    });
  }

  async captureProactive(input) {
    await this.migrate();
    const conversationId = normalizeIdentifier(input.conversation_id, { field: "conversation_id", required: true });
    const assistantId = normalizeIdentifier(input.assistant_id, { field: "assistant_id" });
    const externalEventId = normalizeIdentifier(input.external_event_id, { field: "external_event_id", required: true });
    const observedAt = asIso(input.observed_at || this.now());
    return this._transaction(async client => {
      await this._lockConversation(client, conversationId);
      const existing = await client.query("SELECT archive_message_id FROM archive_messages WHERE external_event_id = $1", [externalEventId]);
      if (existing.rows[0]) return { deduped: true, archive_message_id: existing.rows[0].archive_message_id };
      const message = await this._insertMessage(client, {
        conversation_id: conversationId,
        assistant_id: assistantId,
        role: "assistant",
        content: input.content,
        source: "heartbeat_proactive",
        message_time: input.message_time || observedAt,
        observed_at: observedAt,
        external_event_id: externalEventId,
        confirmed: true,
        completion_status: "complete",
        delivery_status: "unknown",
        reconcile_status: "direct",
        metadata_json: input.metadata_json || {}
      });
      return { deduped: false, archive_message_id: message.archive_message_id };
    });
  }

  async resolveConflict({ conflict_id, status, resolved_by = "reconciliation", resolution_metadata = {} }) {
    if (!["resolved_distinct", "resolved_duplicate", "superseded", "manual_review"].includes(status)) {
      throw archiveError("ARCHIVE_VALIDATION", "conflict status is invalid");
    }
    await this.migrate();
    return this._transaction(async client => {
      const result = await client.query("SELECT * FROM archive_reconciliation_conflicts WHERE conflict_id = $1 FOR UPDATE", [conflict_id]);
      const conflict = result.rows[0];
      if (!conflict) throw archiveError("ARCHIVE_CONFLICT_NOT_FOUND", "conflict is missing");
      if (conflict.status !== "open") return { deduped: true, conflict_id, status: conflict.status };
      if (status === "resolved_duplicate") {
        if (!conflict.candidate_turn_id || !conflict.related_turn_id) throw archiveError("ARCHIVE_VALIDATION", "duplicate resolution needs both turns");
        await client.query("UPDATE archive_turns SET canonical = FALSE, duplicate_of_turn_id = $1 WHERE turn_id = $2", [conflict.related_turn_id, conflict.candidate_turn_id]);
        const candidateMessages = await client.query("SELECT archive_message_id FROM archive_messages WHERE turn_id = $1", [conflict.candidate_turn_id]);
        for (const message of candidateMessages.rows) {
          await client.query("UPDATE archive_messages SET canonical = FALSE, reconcile_status = 'resolved_duplicate' WHERE archive_message_id = $1", [message.archive_message_id]);
        }
      } else if (status === "resolved_distinct" && conflict.candidate_turn_id) {
        await client.query("UPDATE archive_turns SET canonical = TRUE WHERE turn_id = $1", [conflict.candidate_turn_id]);
        const candidateMessages = await client.query("SELECT archive_message_id FROM archive_messages WHERE turn_id = $1", [conflict.candidate_turn_id]);
        for (const message of candidateMessages.rows) {
          await client.query("UPDATE archive_messages SET canonical = TRUE, reconcile_status = 'resolved_distinct' WHERE archive_message_id = $1", [message.archive_message_id]);
        }
      }
      await client.query(
        "UPDATE archive_reconciliation_conflicts SET status = $1, resolved_at = $2, resolved_by = $3, resolution_metadata_json = $4::jsonb WHERE conflict_id = $5",
        [status, this.now().toISOString(), resolved_by, JSON.stringify(sanitizeArchiveJson(resolution_metadata)), conflict_id]
      );
      return { conflict_id, deduped: false, status };
    });
  }

  async listMessages({ conversation_id, date, limit, cursor, dateRange, include_duplicates = false }) {
    await this.migrate();
    const conversationId = normalizeIdentifier(conversation_id, { field: "conversation_id", required: true });
    const args = [conversationId];
    const conditions = ["conversation_id = $1"];
    if (!include_duplicates) conditions.push("canonical = TRUE");
    if (dateRange) {
      args.push(dateRange.start.toISOString(), dateRange.end.toISOString());
      conditions.push(`message_time >= $${args.length - 1} AND message_time < $${args.length}`);
    }
    if (cursor) {
      args.push(cursor.sequence, cursor.id);
      conditions.push(`(sequence > $${args.length - 1} OR (sequence = $${args.length - 1} AND id > $${args.length}))`);
    }
    args.push(limit + 1);
    const rows = await this.pool.query(
      `SELECT id, archive_message_id, conversation_id, assistant_id, turn_id, role, content_text, content_json, source, message_time, observed_at, sequence, canonical, confirmed, completion_status, delivery_status, reconcile_status
       FROM archive_messages WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC, id ASC LIMIT $${args.length}`,
      args
    );
    const hasMore = rows.rows.length > limit;
    const unresolved = await this.pool.query(
      "SELECT COUNT(*)::bigint AS total FROM archive_reconciliation_conflicts WHERE conversation_id = $1 AND status = 'open'",
      [conversationId]
    );
    const page = rows.rows.slice(0, limit).map(row => ({
      ...row,
      id: Number(row.id),
      sequence: Number(row.sequence),
      content_json: parseJson(row.content_json),
      message_time: row.message_time ? new Date(row.message_time).toISOString() : null,
      observed_at: new Date(row.observed_at).toISOString()
    }));
    return {
      conversation_id: conversationId,
      date: date || null,
      messages: page,
      has_more: hasMore,
      unresolved_identity_conflicts: Number(unresolved.rows[0]?.total || 0)
    };
  }

  async stats({ conversation_id, dateRange, include_duplicates = false }) {
    await this.migrate();
    const conversationId = normalizeIdentifier(conversation_id, { field: "conversation_id", required: true });
    const args = [conversationId];
    const conditions = ["conversation_id = $1"];
    if (!include_duplicates) conditions.push("canonical = TRUE");
    if (dateRange) {
      args.push(dateRange.start.toISOString(), dateRange.end.toISOString());
      conditions.push(`message_time >= $${args.length - 1} AND message_time < $${args.length}`);
    }
    const result = await this.pool.query(
      `SELECT COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE role = 'user')::bigint AS user_count,
        COUNT(*) FILTER (WHERE role = 'assistant')::bigint AS assistant_count,
        MIN(message_time) AS first_message_time,
        MAX(message_time) AS last_message_time
       FROM archive_messages WHERE ${conditions.join(" AND ")}`,
      args
    );
    const row = result.rows[0];
    const unresolved = await this.pool.query(
      "SELECT COUNT(*)::bigint AS total FROM archive_reconciliation_conflicts WHERE conversation_id = $1 AND status = 'open'",
      [conversationId]
    );
    return {
      conversation_id: conversationId,
      total: Number(row.total || 0),
      user_count: Number(row.user_count || 0),
      assistant_count: Number(row.assistant_count || 0),
      first_message_time: row.first_message_time ? new Date(row.first_message_time).toISOString() : null,
      last_message_time: row.last_message_time ? new Date(row.last_message_time).toISOString() : null,
      unresolved_identity_conflicts: Number(unresolved.rows[0]?.total || 0)
    };
  }
}

module.exports = {
  ArchiveStore,
  MIGRATION_ADVISORY_LOCK_KEY,
  archiveError,
  identityEquals,
  normalizeIdentifier,
  requestKey,
  resolveRollingOverlap,
  sha256
};
