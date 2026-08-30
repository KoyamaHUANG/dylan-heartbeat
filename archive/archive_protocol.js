const { normalizeContentToText } = require("../timestamp_memory");
const { sanitizeArchiveJson } = require("./archive_content");

const ARCHIVE_PROTOCOL_VERSION = 1;
const ARCHIVE_PROTOCOL_HEADER = "x-kelivo-archive-protocol";
const REQUEST_ID_HEADER = "x-kelivo-request-id";
const USER_MESSAGE_ID_HEADER = "x-kelivo-user-message-id";
const PARENT_REQUEST_ID_HEADER = "x-kelivo-parent-request-id";
const CONVERSATION_ID_HEADER = "x-kelivo-conversation-id";
const ASSISTANT_ID_HEADER = "x-kelivo-assistant-id";

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function identifier(value, field, { required = false } = {}) {
  if (value == null) {
    if (required) throw new Error(`${field}_missing`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new Error(`${field}_missing`);
    return null;
  }
  if (normalized.length > 128 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${field}_invalid`);
  }
  return normalized;
}

function hasImageDataUrl(value) {
  if (typeof value === "string") return /^data:image\/[^;,]+(?:;[^,]*)?;base64,/i.test(value);
  if (Array.isArray(value)) return value.some(hasImageDataUrl);
  if (value && typeof value === "object") return Object.values(value).some(hasImageDataUrl);
  return false;
}

function archiveText(value) {
  if (value && typeof value === "object" && Array.isArray(value.parts)) {
    return value.parts
      .filter(part => part && typeof part === "object" && part.type === "text")
      .map(part => String(part.text || ""))
      .join("");
  }
  return normalizeContentToText(value);
}

function normalizedArchiveContent(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("user_archive_content_invalid");
  }
  if (hasImageDataUrl(value)) throw new Error("user_archive_content_contains_base64");
  const sanitized = sanitizeArchiveJson(value);
  if (!Array.isArray(sanitized.parts)) throw new Error("user_archive_content_parts_missing");
  return sanitized;
}

function isoTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("user_message_time_invalid");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("user_message_time_invalid");
  return date.toISOString();
}

function validateArchiveIdentity({ headers = {}, body = {} } = {}) {
  const headerVersion = String(header(headers, ARCHIVE_PROTOCOL_HEADER) || "").trim();
  const envelope = body?._kelivo_archive;
  if (!headerVersion && envelope == null) {
    return { valid: false, reason: "legacy_untrusted_user_identity" };
  }
  try {
    if (headerVersion !== String(ARCHIVE_PROTOCOL_VERSION)) throw new Error("protocol_header_invalid");
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("envelope_missing");
    if (envelope.version !== ARCHIVE_PROTOCOL_VERSION) throw new Error("protocol_version_mismatch");
    const kind = String(envelope.kind || "");
    if (!["user_send", "continuation"].includes(kind)) throw new Error("kind_invalid");

    const conversationId = identifier(envelope.conversation_id, "conversation_id", { required: true });
    const assistantId = identifier(envelope.assistant_id, "assistant_id");
    const requestId = identifier(envelope.request_id, "request_id", { required: true });
    if (identifier(header(headers, CONVERSATION_ID_HEADER), "header_conversation_id", { required: true }) !== conversationId) {
      throw new Error("conversation_id_mismatch");
    }
    const headerAssistant = identifier(header(headers, ASSISTANT_ID_HEADER), "header_assistant_id");
    if (headerAssistant !== assistantId) throw new Error("assistant_id_mismatch");
    if (identifier(header(headers, REQUEST_ID_HEADER), "header_request_id", { required: true }) !== requestId) {
      throw new Error("request_id_mismatch");
    }

    if (kind === "continuation") {
      const parentRequestId = identifier(envelope.parent_request_id, "parent_request_id", { required: true });
      if (identifier(header(headers, PARENT_REQUEST_ID_HEADER), "header_parent_request_id", { required: true }) !== parentRequestId ||
          parentRequestId !== requestId) {
        throw new Error("parent_request_id_mismatch");
      }
      if (envelope.user_message_id != null || header(headers, USER_MESSAGE_ID_HEADER) != null ||
          envelope.user_message_index != null || envelope.user_message_time != null || envelope.user_archive_content != null) {
        throw new Error("continuation_must_not_identify_user_message");
      }
      return { valid: true, identity: { version: ARCHIVE_PROTOCOL_VERSION, kind, conversation_id: conversationId, assistant_id: assistantId, request_id: requestId, root_request_id: parentRequestId } };
    }

    const userMessageId = identifier(envelope.user_message_id, "user_message_id", { required: true });
    if (identifier(header(headers, USER_MESSAGE_ID_HEADER), "header_user_message_id", { required: true }) !== userMessageId) {
      throw new Error("user_message_id_mismatch");
    }
    if (!Number.isInteger(envelope.user_message_index) || envelope.user_message_index < 0 ||
        !Array.isArray(body.messages) || envelope.user_message_index >= body.messages.length) {
      throw new Error("user_message_index_invalid");
    }
    const indexed = body.messages[envelope.user_message_index];
    if (!indexed || indexed.role !== "user") throw new Error("user_message_index_role_invalid");
    const userArchiveContent = normalizedArchiveContent(envelope.user_archive_content);
    // The index is consistency proof only. It must agree with safe text, but
    // the canonical archive payload below still comes only from the envelope.
    const archivedText = archiveText(userArchiveContent);
    const indexedText = normalizeContentToText(indexed.content);
    if (archivedText && !indexedText.includes(archivedText)) {
      throw new Error("user_archive_content_mismatch");
    }
    return {
      valid: true,
      identity: {
        version: ARCHIVE_PROTOCOL_VERSION,
        kind,
        conversation_id: conversationId,
        assistant_id: assistantId,
        request_id: requestId,
        root_request_id: requestId,
        user_message_id: userMessageId,
        user_message_index: envelope.user_message_index,
        user_message_time: isoTimestamp(envelope.user_message_time),
        user_archive_content: userArchiveContent
      }
    };
  } catch (error) {
    return { valid: false, reason: String(error?.message || "archive_identity_invalid") };
  }
}

module.exports = {
  ARCHIVE_PROTOCOL_HEADER,
  ARCHIVE_PROTOCOL_VERSION,
  ASSISTANT_ID_HEADER,
  CONVERSATION_ID_HEADER,
  PARENT_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  USER_MESSAGE_ID_HEADER,
  archiveText,
  hasImageDataUrl,
  validateArchiveIdentity
};
