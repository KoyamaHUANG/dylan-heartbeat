const { ArchiveStore, archiveError, sha256 } = require("./archive_store");
const { stableJson } = require("./archive_content");

function readBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeClientRequestId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function extractClientRequestId(headers = {}) {
  // Kelivo does not currently provide one. These standard/forward-compatible
  // headers are optional; without one Archive intentionally does not dedupe.
  return normalizeClientRequestId(
    headers["idempotency-key"] ||
    headers["x-kelivo-request-id"] ||
    headers["x-request-id"]
  );
}

function buildChatCaptureInput({ archiveIdentity, observedAt = new Date() }) {
  if (!archiveIdentity) return null;
  if (archiveIdentity.kind === "continuation") {
    return {
      kind: "continuation",
      conversation_id: archiveIdentity.conversation_id,
      assistant_id: archiveIdentity.assistant_id || null,
      client_request_id: archiveIdentity.request_id,
      root_request_id: archiveIdentity.root_request_id,
      archive_protocol_version: archiveIdentity.version,
      observed_at: new Date(observedAt).toISOString()
    };
  }
  if (archiveIdentity.kind !== "user_send") return null;
  const request_context_hash = sha256(stableStringify({
    version: 2,
    conversation_id: archiveIdentity.conversation_id,
    assistant_id: archiveIdentity.assistant_id || null,
    request_id: archiveIdentity.request_id,
    user_message_id: archiveIdentity.user_message_id,
    user_archive_content: stableJson(archiveIdentity.user_archive_content)
  }));
  return {
    conversation_id: archiveIdentity.conversation_id,
    assistant_id: archiveIdentity.assistant_id || null,
    client_request_id: archiveIdentity.request_id,
    client_user_message_id: archiveIdentity.user_message_id,
    archive_protocol_version: archiveIdentity.version,
    identity_status: "verified",
    root_request_id: archiveIdentity.root_request_id,
    client_user_message_time: archiveIdentity.user_message_time,
    observed_at: new Date(observedAt).toISOString(),
    latest_user: {
      role: "user",
      content: archiveIdentity.user_archive_content,
      message_time: archiveIdentity.user_message_time
    },
    request_context_hash
  };
}

function errorCategory(error) {
  if (!error) return "archive_error";
  if (String(error.code || "").startsWith("ARCHIVE_")) return String(error.code).toLowerCase();
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P01"].includes(error.code)) return "database_unavailable";
  return "archive_error";
}

class ArchiveChatCapture {
  constructor(service, input, { continuation = false } = {}) {
    this.service = service;
    this.input = input;
    this.continuation = continuation;
    this.turnResult = service.schedule(
      continuation ? "incoming_continuation" : "incoming_turn",
      () => service.runForConversation(
        input.conversation_id,
        () => continuation ? service._captureContinuation(input) : service._captureIncoming(input)
      )
    );
  }

  archiveAssistant(payload, { observedAt = new Date(), metadata = {} } = {}) {
    const assistant = payload && typeof payload === "object" && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "content")
      ? payload
      : { content: payload };
    return this.service.schedule("assistant", async () => {
      const turn = await this.turnResult;
      if (!turn?.turn_id) return { skipped: true };
      if (assistant.intermediate === true) {
        return this.service._captureAssistantPhase(turn.turn_id, {
          ...assistant,
          observed_at: observedAt,
          metadata_json: { ...(assistant.metadata_json || {}), ...metadata }
        });
      }
      return this.service._captureAssistant(turn.turn_id, {
        ...assistant,
        observed_at: observedAt,
        metadata_json: { ...(assistant.metadata_json || {}), ...metadata }
      });
    });
  }

  archiveAssistantTerminal({ observedAt = new Date(), status, metadata = {} } = {}) {
    return this.service.schedule("assistant_terminal", async () => {
      const turn = await this.turnResult;
      if (!turn?.turn_id) return { skipped: true };
      return this.service._markAssistantTerminal(turn.turn_id, { observed_at: observedAt, status, metadata_json: metadata });
    });
  }
}

class RawChatArchiveService {
  constructor({ enabled = readBoolean(process.env.ARCHIVE_ENABLED), databaseUrl = process.env.ARCHIVE_DATABASE_URL, store = null, poolFactory = null, logger = console } = {}) {
    this.enabled = Boolean(enabled) && Boolean(String(databaseUrl || "").trim() || store);
    this.databaseUrl = String(databaseUrl || "").trim();
    this.store = store;
    this.poolFactory = poolFactory;
    this.logger = logger;
    this.pending = new Set();
    this.conversationQueues = new Map();
    this.initializing = null;
    this.disabledLogged = false;
  }

  _safeLog(method, payload) {
    try { this.logger?.[method]?.(JSON.stringify(payload)); } catch {}
  }

  _disabled() {
    if (!this.disabledLogged) {
      this.disabledLogged = true;
      this._safeLog("log", { event: "archive_disabled" });
    }
    return { skipped: true, reason: "archive_disabled" };
  }

  async _ensureStore() {
    if (!this.enabled) throw archiveError("ARCHIVE_DISABLED", "archive is disabled");
    if (this.store) {
      await this.store.migrate();
      return this.store;
    }
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      let pool;
      try {
        if (this.poolFactory) {
          pool = this.poolFactory(this.databaseUrl);
        } else {
          const { Pool } = require("pg");
          pool = new Pool({
            connectionString: this.databaseUrl,
            max: 2,
            connectionTimeoutMillis: 3000,
            idleTimeoutMillis: 10000,
            query_timeout: 5000,
            statement_timeout: 5000
          });
        }
        const store = new ArchiveStore({ pool });
        await store.migrate();
        this.store = store;
        return store;
      } catch (error) {
        try { await pool?.end?.(); } catch {}
        throw error;
      } finally {
        this.initializing = null;
      }
    })();
    return this.initializing;
  }

  async _captureIncoming(input) {
    const store = await this._ensureStore();
    return store.captureIncomingTurn(input);
  }

  async _captureAssistant(turnId, input) {
    const store = await this._ensureStore();
    return store.captureAssistantForTurn({ turn_id: turnId, ...input });
  }

  async _markAssistantTerminal(turnId, input) {
    const store = await this._ensureStore();
    return store.markAssistantTerminal({ turn_id: turnId, ...input });
  }

  async _captureAssistantPhase(turnId, input) {
    const store = await this._ensureStore();
    return store.captureAssistantPhaseForTurn({ turn_id: turnId, ...input });
  }

  schedule(kind, operation) {
    if (!this.enabled) return Promise.resolve(this._disabled());
    const task = Promise.resolve()
      .then(operation)
      .then(result => {
        if (result?.event) this._safeLog(result.event === "archive_identity_conflict" ? "warn" : "log", { event: result.event, reason: result.reason });
        if (!result?.skipped) this._safeLog("log", { event: "archive_write_success", kind, deduped: Boolean(result?.deduped) });
        return result;
      })
      .catch(error => {
        if (error?.archive_migration) {
          this._safeLog("warn", { event: "archive_migration_failed", error_category: errorCategory(error) });
        }
        this._safeLog("warn", { event: "archive_write_failed", kind, error_category: errorCategory(error) });
        return { skipped: true, error_category: errorCategory(error) };
      });
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
    return task;
  }

  runForConversation(conversationId, operation) {
    const previous = this.conversationQueues.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.conversationQueues.set(conversationId, current);
    const clear = () => {
      if (this.conversationQueues.get(conversationId) === current) this.conversationQueues.delete(conversationId);
    };
    current.then(clear, clear);
    return current;
  }

  captureChatRequest(input, { skipReason = "missing_archive_identity" } = {}) {
    if (!input) {
      this._safeLog("log", { event: "archive_chat_skipped", reason: skipReason });
      return {
        archiveAssistant: () => Promise.resolve({ skipped: true }),
        archiveAssistantTerminal: () => Promise.resolve({ skipped: true })
      };
    }
    if (!this.enabled) {
      this._disabled();
      return {
        archiveAssistant: () => Promise.resolve({ skipped: true }),
        archiveAssistantTerminal: () => Promise.resolve({ skipped: true })
      };
    }
    if (input.kind === "continuation") {
      return new ArchiveChatCapture(this, input, { continuation: true });
    }
    return new ArchiveChatCapture(this, input);
  }

  async _captureContinuation(input) {
    const store = await this._ensureStore();
    return store.captureContinuation(input);
  }

  captureProactive(input) {
    return this.schedule("proactive", async () => {
      const store = await this._ensureStore();
      return store.captureProactive(input);
    });
  }

  async listMessages(input) {
    const store = await this._ensureStore();
    return store.listMessages(input);
  }

  async stats(input) {
    const store = await this._ensureStore();
    return store.stats(input);
  }

  async flush() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async close() {
    await this.flush();
    await this.store?.close?.();
  }
}

module.exports = {
  ArchiveChatCapture,
  RawChatArchiveService,
  buildChatCaptureInput,
  errorCategory,
  extractClientRequestId,
  stableStringify
};
