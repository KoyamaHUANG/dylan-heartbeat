const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runtimeDirectory, runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const CONTEXT_VERSION = 2;
const LEGACY_FILE_PATH = runtimeFile("kelivo_sync_context.json");
const DEFAULT_FILE_PATH = runtimeFile("kelivo_sync_context_v2.json");
const STATE_DIRECTORY = runtimeDirectory("conversation_state", "conversation_state");

function contextValidationError(message) {
  const error = new Error(message);
  error.code = "KELIVO_SYNC_CONTEXT_VALIDATION";
  return error;
}

function normalizeIdentifier(value, { field, required = false, maxLength = 128 } = {}) {
  if (value == null) {
    if (required) throw contextValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw contextValidationError(`${field} must be a string`);
  const normalized = String(value).trim();
  if (!normalized) {
    if (required) throw contextValidationError(`${field} is required`);
    return null;
  }
  if (normalized.length > maxLength) throw contextValidationError(`${field} is too long`);
  if (/[\u0000-\u001F\u007F]/.test(normalized)) throw contextValidationError(`${field} contains control characters`);
  return normalized;
}

function validateKelivoSyncContext(input = {}) {
  const latest_user_fingerprint = String(input.latest_user_fingerprint || "").trim();
  if (!latest_user_fingerprint || latest_user_fingerprint.length > 512) {
    throw contextValidationError("latest_user_fingerprint is invalid");
  }
  return {
    version: CONTEXT_VERSION,
    conversation_id: normalizeIdentifier(input.conversation_id, {
      field: "conversation_id",
      required: true,
      maxLength: 128
    }),
    assistant_id: normalizeIdentifier(input.assistant_id, {
      field: "assistant_id",
      required: true,
      maxLength: 128
    }),
    latest_user_fingerprint,
    updated_at: new Date(input.updated_at || Date.now()).toISOString()
  };
}

function contextKey(binding) {
  const normalized = validateKelivoSyncContext({
    ...binding,
    latest_user_fingerprint: binding.latest_user_fingerprint || "state-key"
  });
  return crypto
    .createHash("sha256")
    .update(`assistant:${normalized.assistant_id}\u0000conversation:${normalized.conversation_id}`, "utf8")
    .digest("hex");
}

function getConversationStatePaths(binding, stateDirectory = STATE_DIRECTORY) {
  const key = contextKey(binding);
  const directory = path.join(stateDirectory, key);
  return {
    key,
    directory,
    timeline_file: path.join(directory, "enhanced_messages.json"),
    timestamp_db_file: path.join(directory, "message_timestamps.json")
  };
}

function emptyContextStore() {
  return { version: CONTEXT_VERSION, contexts: [] };
}

function normalizeContextStore(value) {
  if (!value || value.version !== CONTEXT_VERSION || !Array.isArray(value.contexts)) return emptyContextStore();
  const byKey = new Map();
  for (const candidate of value.contexts) {
    try {
      const normalized = validateKelivoSyncContext(candidate);
      byKey.set(contextKey(normalized), normalized);
    } catch {}
  }
  return {
    version: CONTEXT_VERSION,
    contexts: [...byKey.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  };
}

function loadKelivoSyncContexts(filePath = DEFAULT_FILE_PATH) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return normalizeContextStore(JSON.parse(fs.readFileSync(filePath, "utf8"))).contexts;
  } catch {
    return [];
  }
}

// An old single global context has no reliable target identity for a wake run.
// It remains untouched at kelivo_sync_context.json and is never auto-migrated.
function hasLegacyUnboundContext(filePath = LEGACY_FILE_PATH) {
  return fs.existsSync(filePath);
}

function loadKelivoSyncContext(binding, filePath = DEFAULT_FILE_PATH) {
  if (!binding) return null;
  try {
    const key = contextKey(binding);
    return loadKelivoSyncContexts(filePath).find(context => contextKey(context) === key) || null;
  } catch {
    return null;
  }
}

function saveKelivoSyncContext(input, filePath = DEFAULT_FILE_PATH) {
  const context = validateKelivoSyncContext(input);
  const store = normalizeContextStore({ version: CONTEXT_VERSION, contexts: loadKelivoSyncContexts(filePath) });
  const key = contextKey(context);
  const index = store.contexts.findIndex(candidate => contextKey(candidate) === key);
  if (index >= 0) store.contexts[index] = context;
  else store.contexts.push(context);
  store.contexts.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  writeJsonAtomicSync(filePath, store);
  return context;
}

function parseKelivoSyncHeaders(headers = {}) {
  const rawConversation = headers["x-kelivo-conversation-id"];
  const rawAssistant = headers["x-kelivo-assistant-id"];
  const conversationHeaderPresent = rawConversation != null;
  const assistantHeaderPresent = rawAssistant != null;
  if (!conversationHeaderPresent && !assistantHeaderPresent) return { provided: false };
  if (!conversationHeaderPresent) {
    throw contextValidationError("conversation_id is required when assistant_id is provided");
  }
  const conversation_id = normalizeIdentifier(rawConversation, {
    field: "conversation_id",
    required: true,
    maxLength: 128
  });
  if (!assistantHeaderPresent) {
    // Keep older clients talking normally, but never convert a partial header
    // into a wake target or a shared scoped state.
    return { provided: false, legacy_unbound: true, conversation_id };
  }
  return {
    provided: true,
    conversation_id,
    assistant_id: normalizeIdentifier(rawAssistant, {
      field: "assistant_id",
      required: true,
      maxLength: 128
    })
  };
}

module.exports = {
  CONTEXT_VERSION,
  DEFAULT_FILE_PATH,
  LEGACY_FILE_PATH,
  contextKey,
  contextValidationError,
  getConversationStatePaths,
  hasLegacyUnboundContext,
  loadKelivoSyncContext,
  loadKelivoSyncContexts,
  parseKelivoSyncHeaders,
  saveKelivoSyncContext,
  validateKelivoSyncContext
};
