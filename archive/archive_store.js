const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { archiveContent, contentFingerprint, messageIdentity } = require("./archive_content");

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
  if (!["direct", "seeded", "reconciled", "conflict", "pending"].includes(result)) {
    throw archiveError("ARCHIVE_VALIDATION", "reconcile_status is invalid");
  }
  return result;
}

function identityEquals(left, right) {
  return left?.role === right?.role && left?.fingerprint === right?.fingerprint;
}

function findReliableOverlap(tail, visible) {
  const maximum = Math.min(tail.length, visible.length);
  for (let size = maximum; size >= 2; size -= 1) {
    const tailSlice = tail.slice(-size);
    const visibleSlice = visible.slice(0, size);
    if (tailSlice.every((message, index) => identityEquals(message, visibleSlice[index]))) return size;
  }
  return 0;
}

function requestKey({ conversationId, assistantId, predecessorSequence, requestContextHash }) {
  return sha256(JSON.stringify({
    version: 1,
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
  constructor({ pool, migrationsDirectory = path.join(__dirname, "..", "migrations"), now = () => new Date(), retryWindowMs = 10 * 60 * 1000 } = {}) {
    if (!pool || typeof pool.connect !== "function") throw new Error("ArchiveStore requires a PostgreSQL pool");
    this.pool = pool;
    this.migrationsDirectory = migrationsDirectory;
    this.now = now;
    this.retryWindowMs = retryWindowMs;
    this.migrated = false;
    this.migrationPromise = null;
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

  async _migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
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

  async _allocateSequence(client, conversationId) {
    const result = await client.query(
      "UPDATE archive_conversations SET next_sequence = next_sequence + 1, updated_at = NOW() WHERE conversation_id = $1 RETURNING next_sequence - 1 AS sequence",
      [conversationId]
    );
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
    const content = input.content_json == null
      ? archiveContent(input.content)
      : { content_text: String(input.content_text || ""), content_json: input.content_json };
    const archive_message_id = input.archive_message_id || crypto.randomUUID();
    const sequence = await this._allocateSequence(client, input.conversation_id);
    const fingerprint = input.fingerprint || contentFingerprint(role, content.content_json);
    const result = await client.query(
      `INSERT INTO archive_messages (
        archive_message_id, conversation_id, assistant_id, role, content_text, content_json,
        source, message_time, observed_at, sequence, fingerprint, turn_key,
        external_event_id, confirmed, reconcile_status, metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb
      ) RETURNING id, archive_message_id, sequence`,
      [
        archive_message_id,
        input.conversation_id,
        input.assistant_id || null,
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
        Boolean(input.confirmed),
        normalizeStatus(input.reconcile_status, "pending"),
        JSON.stringify(input.metadata_json || {})
      ]
    );
    return result.rows[0];
  }

  async _tail(client, conversationId, limit = 80) {
    const result = await client.query(
      "SELECT id, archive_message_id, role, fingerprint, sequence FROM archive_messages WHERE conversation_id = $1 ORDER BY sequence DESC, id DESC LIMIT $2",
      [conversationId, limit]
    );
    return result.rows.reverse();
  }

  async _recordConflict(client, { conversationId, requestContextHash, reason, observedAt, metadata = {} }) {
    await client.query(
      "INSERT INTO archive_reconciliation_conflicts (conflict_id, conversation_id, request_context_hash, reason, observed_at, metadata_json) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [crypto.randomUUID(), conversationId, requestContextHash, reason, asIso(observedAt || this.now()), JSON.stringify(metadata)]
    );
  }

  async _findRecentRetry(client, conversationId, requestContextHash, observedAt) {
    const result = await client.query(
      "SELECT turn_id, status, started_at FROM archive_turns WHERE conversation_id = $1 AND request_context_hash = $2 ORDER BY started_at DESC LIMIT 1",
      [conversationId, requestContextHash]
    );
    const turn = result.rows[0];
    if (!turn) return null;
    const age = new Date(observedAt).getTime() - new Date(turn.started_at).getTime();
    return Number.isFinite(age) && age >= 0 && age <= this.retryWindowMs ? turn : null;
  }

  async captureIncomingTurn(input) {
    await this.migrate();
    const conversationId = normalizeIdentifier(input.conversation_id, { field: "conversation_id", required: true });
    const assistantId = normalizeIdentifier(input.assistant_id, { field: "assistant_id" });
    const observedAt = asIso(input.observed_at || this.now());
    const latestUser = input.latest_user;
    if (!latestUser || latestUser.role !== "user") throw archiveError("ARCHIVE_VALIDATION", "latest_user is invalid");
    const requestContextHash = String(input.request_context_hash || "");
    if (!/^[0-9a-f]{64}$/i.test(requestContextHash)) throw archiveError("ARCHIVE_VALIDATION", "request_context_hash is invalid");
    const visible = Array.isArray(input.visible_context) ? input.visible_context : [];

    return this._transaction(async client => {
      await this._lockConversation(client, conversationId);
      const retry = await this._findRecentRetry(client, conversationId, requestContextHash, observedAt);
      if (retry) {
        await this._recordConflict(client, {
          conversationId,
          requestContextHash,
          reason: "retry_heuristic_reused_turn",
          observedAt,
          metadata: { retry_turn_id: retry.turn_id }
        });
        return { turn_id: retry.turn_id, deduped: true, status: retry.status };
      }

      let tail = await this._tail(client, conversationId);
      const hasConversation = tail.length > 0;
      let reconcileStatus = "direct";
      if (!hasConversation) {
        for (const message of visible) {
          await this._insertMessage(client, {
            conversation_id: conversationId,
            assistant_id: assistantId,
            role: message.role,
            content: message.content,
            source: "initial_context_seed",
            message_time: message.message_time,
            observed_at: observedAt,
            confirmed: true,
            reconcile_status: "seeded",
            metadata_json: { message_time_known: Boolean(message.message_time) }
          });
        }
        tail = await this._tail(client, conversationId);
      } else if (visible.length > 0) {
        const overlap = findReliableOverlap(tail, visible.map(messageIdentity));
        if (overlap > 0) {
          const unmatched = visible.slice(overlap);
          for (const message of unmatched) {
            await this._insertMessage(client, {
              conversation_id: conversationId,
              assistant_id: assistantId,
              role: message.role,
              content: message.content,
              source: "reconciled_context",
              message_time: message.message_time,
              observed_at: observedAt,
              confirmed: true,
              reconcile_status: "reconciled",
              metadata_json: { message_time_known: Boolean(message.message_time) }
            });
          }
          tail = await this._tail(client, conversationId);
        } else {
          const tailLast = tail.at(-1);
          const visibleLast = messageIdentity(visible.at(-1));
          if (!identityEquals(tailLast, visibleLast)) {
            reconcileStatus = "conflict";
            await this._recordConflict(client, {
              conversationId,
              requestContextHash,
              reason: "rolling_context_no_reliable_overlap",
              observedAt,
              metadata: { visible_count: visible.length, archived_tail_count: tail.length }
            });
          }
        }
      }

      const predecessorSequence = tail.at(-1)?.sequence || 0;
      const turnKey = requestKey({ conversationId, assistantId, predecessorSequence, requestContextHash });
      const user = await this._insertMessage(client, {
        conversation_id: conversationId,
        assistant_id: assistantId,
        role: "user",
        content: latestUser.content,
        source: "kelivo_live_user",
        message_time: latestUser.message_time || observedAt,
        observed_at: observedAt,
        confirmed: true,
        reconcile_status: reconcileStatus,
        turn_key: turnKey,
        metadata_json: { message_time_known: true }
      });
      const turnId = crypto.randomUUID();
      await client.query(
        "INSERT INTO archive_turns (turn_id, conversation_id, assistant_id, request_key, request_context_hash, predecessor_sequence, user_archive_message_id, status, started_at, metadata_json) VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_assistant', $8, $9::jsonb)",
        [turnId, conversationId, assistantId, turnKey, requestContextHash, predecessorSequence || null, user.archive_message_id, observedAt, JSON.stringify({})]
      );
      return { turn_id: turnId, user_archive_message_id: user.archive_message_id, deduped: false, status: "awaiting_assistant" };
    });
  }

  async captureAssistantForTurn({ turn_id, content, observed_at, metadata_json = {} }) {
    await this.migrate();
    const observedAt = asIso(observed_at || this.now());
    return this._transaction(async client => {
      const turnResult = await client.query("SELECT * FROM archive_turns WHERE turn_id = $1", [turn_id]);
      const turn = turnResult.rows[0];
      if (!turn) throw archiveError("ARCHIVE_TURN_NOT_FOUND", "archive turn was not found");
      if (turn.status === "completed") return { deduped: true, turn_id };
      const assistant = await this._insertMessage(client, {
        conversation_id: turn.conversation_id,
        assistant_id: turn.assistant_id,
        role: "assistant",
        content,
        source: "gateway_assistant",
        message_time: observedAt,
        observed_at: observedAt,
        confirmed: true,
        reconcile_status: "direct",
        turn_key: turn.request_key,
        metadata_json
      });
      await client.query(
        "UPDATE archive_turns SET assistant_archive_message_id = $1, status = 'completed', completed_at = $2 WHERE turn_id = $3",
        [assistant.archive_message_id, observedAt, turn_id]
      );
      return { turn_id, archive_message_id: assistant.archive_message_id, deduped: false };
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
        reconcile_status: "direct",
        metadata_json: input.metadata_json || {}
      });
      return { deduped: false, archive_message_id: message.archive_message_id };
    });
  }

  async listMessages({ conversation_id, date, limit, cursor, dateRange }) {
    await this.migrate();
    const conversationId = normalizeIdentifier(conversation_id, { field: "conversation_id", required: true });
    const args = [conversationId];
    const conditions = ["conversation_id = $1"];
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
      `SELECT id, archive_message_id, conversation_id, assistant_id, role, content_text, content_json, source, message_time, observed_at, sequence, confirmed, reconcile_status
       FROM archive_messages WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC, id ASC LIMIT $${args.length}`,
      args
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit).map(row => ({
      ...row,
      id: Number(row.id),
      sequence: Number(row.sequence),
      content_json: parseJson(row.content_json),
      message_time: row.message_time ? new Date(row.message_time).toISOString() : null,
      observed_at: new Date(row.observed_at).toISOString()
    }));
    return { conversation_id: conversationId, date: date || null, messages: page, has_more: hasMore };
  }

  async stats({ conversation_id, dateRange }) {
    await this.migrate();
    const conversationId = normalizeIdentifier(conversation_id, { field: "conversation_id", required: true });
    const args = [conversationId];
    const conditions = ["conversation_id = $1"];
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
    return {
      conversation_id: conversationId,
      total: Number(row.total || 0),
      user_count: Number(row.user_count || 0),
      assistant_count: Number(row.assistant_count || 0),
      first_message_time: row.first_message_time ? new Date(row.first_message_time).toISOString() : null,
      last_message_time: row.last_message_time ? new Date(row.last_message_time).toISOString() : null
    };
  }
}

module.exports = {
  ArchiveStore,
  archiveError,
  findReliableOverlap,
  identityEquals,
  normalizeIdentifier,
  requestKey,
  sha256
};
