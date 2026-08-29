const crypto = require("crypto");

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function cursorSignature(encodedPayload, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(encodedPayload).digest("base64url");
}

function createArchiveCursor(payload, secret) {
  const encodedPayload = encodeBase64Url(JSON.stringify({ v: 1, ...payload }));
  return `${encodedPayload}.${cursorSignature(encodedPayload, secret)}`;
}

function cursorError(message) {
  const error = new Error(message);
  error.code = "ARCHIVE_CURSOR_INVALID";
  return error;
}

function parseArchiveCursor(cursor, secret, expected = {}) {
  if (typeof cursor !== "string" || cursor.length < 10 || cursor.length > 2048) throw cursorError("cursor is invalid");
  const [encodedPayload, signature, extra] = cursor.split(".");
  if (!encodedPayload || !signature || extra) throw cursorError("cursor is invalid");
  const expectedSignature = cursorSignature(encodedPayload, secret);
  const received = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (received.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(received, expectedSignatureBuffer)) throw cursorError("cursor signature is invalid");
  let payload;
  try { payload = JSON.parse(decodeBase64Url(encodedPayload)); } catch { throw cursorError("cursor payload is invalid"); }
  if (!payload || payload.v !== 1 || !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || !Number.isSafeInteger(payload.id) || payload.id < 0) {
    throw cursorError("cursor payload is invalid");
  }
  if (
    payload.conversation_id !== expected.conversation_id ||
    (payload.date || null) !== (expected.date || null) ||
    Boolean(payload.include_duplicates) !== Boolean(expected.include_duplicates)
  ) {
    throw cursorError("cursor does not match query");
  }
  return payload;
}

module.exports = { createArchiveCursor, parseArchiveCursor };
