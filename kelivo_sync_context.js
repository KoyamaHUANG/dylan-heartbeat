const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const CONTEXT_VERSION = 1;
const DEFAULT_FILE_PATH = runtimeFile("kelivo_sync_context.json");

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
    assistant_id: normalizeIdentifier(input.assistant_id, { field: "assistant_id", maxLength: 128 }),
    latest_user_fingerprint,
    updated_at: new Date().toISOString()
  };
}

function loadKelivoSyncContext(filePath = DEFAULT_FILE_PATH) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const normalized = validateKelivoSyncContext(raw);
    const updatedAt = new Date(raw.updated_at);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { ...normalized, updated_at: updatedAt.toISOString() };
  } catch {
    return null;
  }
}

function saveKelivoSyncContext(input, filePath = DEFAULT_FILE_PATH) {
  const context = validateKelivoSyncContext(input);
  writeJsonAtomicSync(filePath, context);
  return context;
}

function parseKelivoSyncHeaders(headers = {}) {
  const rawConversation = headers["x-kelivo-conversation-id"];
  const rawAssistant = headers["x-kelivo-assistant-id"];
  const conversationHeaderPresent = rawConversation != null;
  const assistantHeaderPresent = rawAssistant != null;
  if (!conversationHeaderPresent && !assistantHeaderPresent) return { provided: false };
  if (!conversationHeaderPresent) throw contextValidationError("conversation_id is required when assistant_id is provided");
  return {
    provided: true,
    conversation_id: normalizeIdentifier(rawConversation, {
      field: "conversation_id",
      required: true,
      maxLength: 128
    }),
    assistant_id: normalizeIdentifier(rawAssistant, { field: "assistant_id", maxLength: 128 })
  };
}

module.exports = {
  contextValidationError,
  loadKelivoSyncContext,
  parseKelivoSyncHeaders,
  saveKelivoSyncContext,
  validateKelivoSyncContext
};
