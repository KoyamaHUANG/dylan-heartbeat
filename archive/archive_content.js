const crypto = require("crypto");
const { normalizeContentToText } = require("../timestamp_memory");

function imageDataUrlMetadata(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/i);
  if (!match || !/^image\//i.test(match[1] || "")) return null;
  const base64 = match[2] || "";
  return {
    archived_placeholder: "image_data_omitted",
    mime_type: match[1].toLowerCase(),
    size_bytes: Math.floor((base64.replace(/\s/g, "").length * 3) / 4),
    sha256: crypto.createHash("sha256").update(base64).digest("hex")
  };
}

function sanitizeArchiveJson(value) {
  const imageMetadata = imageDataUrlMetadata(value);
  if (imageMetadata) return imageMetadata;
  if (Array.isArray(value)) return value.map(sanitizeArchiveJson);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = sanitizeArchiveJson(child);
    return result;
  }
  if (["string", "number", "boolean"].includes(typeof value) || value == null) return value;
  return String(value);
}

function archiveContent(content) {
  return {
    content_text: normalizeContentToText(content),
    content_json: sanitizeArchiveJson(content)
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function contentFingerprint(role, contentJson) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ role: String(role || ""), content: stableJson(contentJson) }))
    .digest("hex");
}

function messageIdentity(message) {
  const content = archiveContent(message?.content);
  return {
    role: String(message?.role || ""),
    content,
    fingerprint: contentFingerprint(message?.role, content.content_json)
  };
}

module.exports = {
  archiveContent,
  contentFingerprint,
  imageDataUrlMetadata,
  messageIdentity,
  sanitizeArchiveJson,
  stableJson
};
