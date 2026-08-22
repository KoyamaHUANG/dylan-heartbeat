const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const STORE_VERSION = 1;
const DEFAULT_MAX_COUNT = 5000;
const ABSOLUTE_MAX_COUNT = 100000;
const DEFAULT_FILE_PATH = runtimeFile("proactive_events.json");

function validationError(message) {
  const error = new Error(message);
  error.code = "PROACTIVE_EVENT_VALIDATION";
  return error;
}

function normalizeIdentifier(value, { field, required = false, maxLength = 128 } = {}) {
  if (value == null) {
    if (required) throw validationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw validationError(`${field} must be a string`);
  const normalized = String(value).trim();
  if (!normalized) {
    if (required) throw validationError(`${field} is required`);
    return null;
  }
  if (normalized.length > maxLength) throw validationError(`${field} is too long`);
  if (/[\u0000-\u001F\u007F]/.test(normalized)) throw validationError(`${field} contains control characters`);
  return normalized;
}

function normalizeText(value, { field, required = false, maxLength } = {}) {
  if (value == null) {
    if (required) throw validationError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw validationError(`${field} must be a string`);
  const normalized = String(value).trim();
  if (!normalized && required) throw validationError(`${field} is required`);
  if (normalized.length > maxLength) throw validationError(`${field} is too long`);
  return normalized;
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (!["wake", "manual_test"].includes(source)) throw validationError("source is invalid");
  return source;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!["bark", "ntfy", "none"].includes(provider)) throw validationError("push_provider is invalid");
  return provider;
}

function validateProactiveEventInput(input = {}) {
  return {
    conversation_id: normalizeIdentifier(input.conversation_id, {
      field: "conversation_id",
      required: true,
      maxLength: 128
    }),
    assistant_id: normalizeIdentifier(input.assistant_id, {
      field: "assistant_id",
      maxLength: 128
    }),
    title: normalizeText(input.title, { field: "title", required: true, maxLength: 100 }),
    body: normalizeText(input.body, { field: "body", required: true, maxLength: 4000 }),
    source: normalizeSource(input.source),
    push_provider: normalizeProvider(input.push_provider)
  };
}

function createEmptyStore() {
  return { version: STORE_VERSION, next_seq: 1, events: [] };
}

function normalizeStoredEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seq = Number(value.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  if (typeof value.event_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.event_id)) return null;
  if (Number.isNaN(new Date(value.created_at).getTime()) || value.role !== "assistant") return null;
  try {
    const normalized = validateProactiveEventInput(value);
    return {
      event_id: value.event_id,
      seq,
      conversation_id: normalized.conversation_id,
      assistant_id: normalized.assistant_id,
      created_at: new Date(value.created_at).toISOString(),
      role: "assistant",
      title: normalized.title,
      body: normalized.body,
      source: normalized.source,
      push_provider: normalized.push_provider
    };
  } catch {
    return null;
  }
}

function normalizeStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return createEmptyStore();
  const bySeq = new Map();
  for (const event of Array.isArray(value.events) ? value.events : []) {
    const normalized = normalizeStoredEvent(event);
    if (normalized && !bySeq.has(normalized.seq)) bySeq.set(normalized.seq, normalized);
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const highestSeq = events.at(-1)?.seq || 0;
  const requestedNextSeq = Number(value.next_seq);
  const next_seq = Number.isSafeInteger(requestedNextSeq) && requestedNextSeq > highestSeq
    ? requestedNextSeq
    : highestSeq + 1;
  return { version: STORE_VERSION, next_seq, events };
}

function loadProactiveStore(filePath = DEFAULT_FILE_PATH) {
  if (!fs.existsSync(filePath)) return createEmptyStore();
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return createEmptyStore();
  }
}

function saveProactiveStore(store, filePath = DEFAULT_FILE_PATH) {
  writeJsonAtomicSync(filePath, normalizeStore(store));
}

function resolveMaxCount(value = process.env.PROACTIVE_EVENT_MAX_COUNT) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ABSOLUTE_MAX_COUNT) return DEFAULT_MAX_COUNT;
  return parsed;
}

function appendProactiveEvent(input, { filePath = DEFAULT_FILE_PATH, maxCount } = {}) {
  const normalized = validateProactiveEventInput(input);
  const store = loadProactiveStore(filePath);
  const event = {
    event_id: crypto.randomUUID(),
    seq: store.next_seq,
    conversation_id: normalized.conversation_id,
    assistant_id: normalized.assistant_id,
    created_at: new Date().toISOString(),
    role: "assistant",
    title: normalized.title,
    body: normalized.body,
    source: normalized.source,
    push_provider: normalized.push_provider
  };
  store.next_seq += 1;
  store.events.push(event);
  const retentionCount = maxCount == null ? resolveMaxCount() : resolveMaxCount(maxCount);
  if (store.events.length > retentionCount) store.events = store.events.slice(-retentionCount);
  saveProactiveStore(store, filePath);
  return { ...event };
}

function parseNonNegativeInteger(value, { field, fallback } = {}) {
  if (value == null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw validationError(`${field} must be a non-negative integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0) throw validationError(`${field} must be a non-negative integer`);
  return number;
}

function parseLimit(value) {
  if (value == null || value === "") return 50;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw validationError("limit must be an integer between 1 and 100");
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) {
    throw validationError("limit must be an integer between 1 and 100");
  }
  return number;
}

function listProactiveEvents(input = {}, { filePath = DEFAULT_FILE_PATH } = {}) {
  const conversation_id = normalizeIdentifier(input.conversation_id, {
    field: "conversation_id",
    required: true,
    maxLength: 128
  });
  const assistant_id = normalizeIdentifier(input.assistant_id, { field: "assistant_id", maxLength: 128 });
  const after_seq = parseNonNegativeInteger(input.after_seq, { field: "after_seq", fallback: 0 });
  const limit = parseLimit(input.limit);
  const store = loadProactiveStore(filePath);
  const matching = store.events.filter(event =>
    event.seq > after_seq &&
    event.conversation_id === conversation_id &&
    (assistant_id == null || event.assistant_id === assistant_id)
  );
  const data = matching.slice(0, limit).map(event => ({ ...event }));
  return {
    conversation_id,
    data,
    next_after_seq: data.length > 0 ? data.at(-1).seq : after_seq,
    oldest_seq: store.events.at(0)?.seq || 0,
    latest_seq: store.events.at(-1)?.seq || 0,
    has_more: matching.length > data.length
  };
}

module.exports = {
  DEFAULT_MAX_COUNT,
  appendProactiveEvent,
  listProactiveEvents,
  loadProactiveStore,
  resolveMaxCount,
  saveProactiveStore,
  validateProactiveEventInput
};
