const { ArchiveStore, archiveError, sha256 } = require("./archive_store");
const { messageIdentity } = require("./archive_content");
const {
  normalizeContentToText,
  parseTimestampLabel,
  getTimestampFromMemory,
  isRealUserMessageForTimeline
} = require("../timestamp_memory");
const { isSpecialEventContent } = require("../special_events");

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

function isArchiveChatMessage(message) {
  if (!message || message.tool_calls) return false;
  if (message.role === "user") return isRealUserMessageForTimeline(message);
  if (message.role !== "assistant") return false;
  return !isSpecialEventContent(normalizeContentToText(message.content));
}

function knownMessageTime(message, timestampDb, timeZone) {
  const fromContent = parseTimestampLabel(normalizeContentToText(message?.content), timeZone);
  if (fromContent) return fromContent.toISOString();
  const fromMemory = getTimestampFromMemory(message, timestampDb);
  return fromMemory ? fromMemory.toISOString() : null;
}

function buildChatCaptureInput({ binding, messages, timestampDb = {}, timeZone, observedAt = new Date() }) {
  if (!binding?.provided || !binding.conversation_id) return null;
  const eligible = (Array.isArray(messages) ? messages : []).filter(isArchiveChatMessage);
  if (eligible.at(-1)?.role !== "user") return null;
  const latest = eligible.at(-1);
  const visible = eligible.slice(0, -1).map(message => ({
    role: message.role,
    content: message.content,
    message_time: knownMessageTime(message, timestampDb, timeZone)
  }));
  const request_context_hash = sha256(stableStringify({
    version: 1,
    conversation_id: binding.conversation_id,
    assistant_id: binding.assistant_id || null,
    messages: eligible.map(messageIdentity)
  }));
  return {
    conversation_id: binding.conversation_id,
    assistant_id: binding.assistant_id || null,
    observed_at: new Date(observedAt).toISOString(),
    visible_context: visible,
    latest_user: {
      role: "user",
      content: latest.content,
      message_time: knownMessageTime(latest, timestampDb, timeZone) || new Date(observedAt).toISOString()
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
  constructor(service, input) {
    this.service = service;
    this.input = input;
    this.turnResult = service.schedule("incoming_turn", () => service.runForConversation(input.conversation_id, () => service._captureIncoming(input)));
  }

  archiveAssistant(content, { observedAt = new Date(), metadata = {} } = {}) {
    return this.service.schedule("assistant", async () => {
      let turn = await this.turnResult;
      if (!turn?.turn_id) turn = await this.service.runForConversation(this.input.conversation_id, () => this.service._captureIncoming(this.input));
      if (!turn?.turn_id) return { skipped: true };
      return this.service._captureAssistant(turn.turn_id, content, observedAt, metadata);
    });
  }
}

class RawChatArchiveService {
  constructor({ enabled = readBoolean(process.env.ARCHIVE_ENABLED), databaseUrl = process.env.ARCHIVE_DATABASE_URL, store = null, poolFactory = null, logger = console, retryWindowMs } = {}) {
    this.enabled = Boolean(enabled) && Boolean(String(databaseUrl || "").trim() || store);
    this.databaseUrl = String(databaseUrl || "").trim();
    this.store = store;
    this.poolFactory = poolFactory;
    this.logger = logger;
    this.retryWindowMs = retryWindowMs;
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
        const store = new ArchiveStore({ pool, retryWindowMs: this.retryWindowMs });
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

  async _captureAssistant(turnId, content, observedAt, metadata) {
    const store = await this._ensureStore();
    return store.captureAssistantForTurn({ turn_id: turnId, content, observed_at: observedAt, metadata_json: metadata });
  }

  schedule(kind, operation) {
    if (!this.enabled) return Promise.resolve(this._disabled());
    const task = Promise.resolve()
      .then(operation)
      .then(result => {
        if (!result?.skipped) this._safeLog("log", { event: "archive_write_success", kind, deduped: Boolean(result?.deduped) });
        return result;
      })
      .catch(error => {
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

  captureChatRequest(input) {
    if (!input) {
      this._safeLog("log", { event: "archive_chat_skipped", reason: "missing_bound_final_user_turn" });
      return { archiveAssistant: () => Promise.resolve({ skipped: true }) };
    }
    if (!this.enabled) {
      this._disabled();
      return { archiveAssistant: () => Promise.resolve({ skipped: true }) };
    }
    return new ArchiveChatCapture(this, input);
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
  isArchiveChatMessage,
  knownMessageTime,
  stableStringify
};
