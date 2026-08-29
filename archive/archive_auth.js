const crypto = require("crypto");

function readBearerToken(value) {
  const match = String(value || "").match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match ? match[1] : "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function authorizeArchiveRequest(headers = {}, configuredKey = process.env.ARCHIVE_API_KEY) {
  const expected = String(configuredKey || "").trim();
  if (!expected) return { allow: false, status: 503, error: "Archive API is not configured", source: "unconfigured" };
  const token = readBearerToken(headers.authorization);
  if (!safeEqual(token, expected)) return { allow: false, status: 401, error: "Unauthorized", source: token ? "invalid" : "missing" };
  return { allow: true, source: "bearer" };
}

module.exports = { authorizeArchiveRequest, readBearerToken, safeEqual };
