const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const PROVENANCE_VERSION = 1;
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_FILE_PATH = runtimeFile("proactive_generation_audit.json");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function loadProactiveProvenance(filePath = DEFAULT_FILE_PATH) {
  if (!fs.existsSync(filePath)) return { version: PROVENANCE_VERSION, records: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.version !== PROVENANCE_VERSION || !Array.isArray(parsed.records)) {
      return { version: PROVENANCE_VERSION, records: [] };
    }
    return { version: PROVENANCE_VERSION, records: parsed.records.filter(record => record && typeof record === "object") };
  } catch {
    return { version: PROVENANCE_VERSION, records: [] };
  }
}

function normalizeArchiveMessageId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeArchiveCompletedAt(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeArchiveErrorCode(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "database_unavailable" || /^archive_[a-z0-9_]{1,80}$/.test(normalized)) {
    return normalized;
  }
  return "archive_error";
}

function appendProactiveProvenance(input = {}, { filePath = DEFAULT_FILE_PATH, maxRecords = DEFAULT_MAX_RECORDS } = {}) {
  const record = {
    request_id: String(input.request_id || "").trim(),
    event_id: input.event_id ? String(input.event_id) : null,
    assistant_id: String(input.assistant_id || "").trim(),
    conversation_id: String(input.conversation_id || "").trim(),
    model: String(input.model || "").trim(),
    generation_timestamp: new Date(input.generation_timestamp || Date.now()).toISOString(),
    input_context_hash: String(input.input_context_hash || "").trim() || null,
    raw_output_hash: String(input.raw_output_hash || "").trim() || null,
    parsed_body_hash: String(input.parsed_body_hash || "").trim() || null,
    validation_result: String(input.validation_result || "unknown"),
    validation_reason: input.validation_reason ? String(input.validation_reason) : null,
    push_result: String(input.push_result || "not_attempted"),
    archive_message_id: normalizeArchiveMessageId(input.archive_message_id),
    archive_result: String(input.archive_result || "not_attempted"),
    archive_completed_at: normalizeArchiveCompletedAt(input.archive_completed_at),
    archive_error_code: normalizeArchiveErrorCode(input.archive_error_code),
    provider: input.provider ? String(input.provider) : null
  };
  if (!record.request_id || !record.assistant_id || !record.conversation_id) {
    throw new Error("proactive provenance requires request and conversation identity");
  }
  const store = loadProactiveProvenance(filePath);
  store.records.push(record);
  if (store.records.length > maxRecords) store.records = store.records.slice(-maxRecords);
  writeJsonAtomicSync(filePath, store);
  return record;
}

// Every mutation is synchronous and atomically replaces the JSON snapshot. In
// the single Node process that owns this runtime state, this makes each exact
// record update indivisible while preserving the existing file-write style.
function updateProactiveProvenance(requestId, patch = {}, { filePath = DEFAULT_FILE_PATH, expectedEventId } = {}) {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) throw new Error("proactive provenance update requires request_id");
  const hasExpectedEventId = Object.prototype.hasOwnProperty.call(arguments[2] || {}, "expectedEventId");
  const normalizedExpectedEventId = expectedEventId == null ? null : String(expectedEventId);
  const store = loadProactiveProvenance(filePath);
  const matches = store.records.filter(record => (
    record.request_id === normalizedRequestId &&
    (!hasExpectedEventId || record.event_id === normalizedExpectedEventId)
  ));
  if (matches.length !== 1) return null;

  const record = matches[0];
  if (Object.prototype.hasOwnProperty.call(patch, "event_id")) {
    record.event_id = patch.event_id == null ? null : String(patch.event_id);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "archive_result")) {
    record.archive_result = String(patch.archive_result || "not_attempted");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "archive_message_id")) {
    record.archive_message_id = normalizeArchiveMessageId(patch.archive_message_id);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "archive_completed_at")) {
    record.archive_completed_at = normalizeArchiveCompletedAt(patch.archive_completed_at);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "archive_error_code")) {
    record.archive_error_code = normalizeArchiveErrorCode(patch.archive_error_code);
  }
  writeJsonAtomicSync(filePath, store);
  return { ...record };
}

module.exports = {
  appendProactiveProvenance,
  loadProactiveProvenance,
  sha256,
  updateProactiveProvenance
};
