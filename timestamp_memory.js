const { zonedWallTimeToDate } = require("./time_utils");

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function parseTimestampLabel(value, timeZone) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, timeZone);
}

function stripLeadingTimestamp(content) {
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg?.content);
  const content = raw.trim().slice(0, 150);
  return `${msg?.role || ""}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg?.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg?.role || ""}::${content}`;
}

function getTimestampFromMemory(msg, timestampDB) {
  if (!timestampDB || typeof timestampDB !== "object" || Array.isArray(timestampDB)) return null;
  const values = [
    timestampDB[makeFingerprint(msg)],
    timestampDB[makeFingerprintStripped(msg)]
  ];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function isRealUserMessageForTimeline(msg) {
  if (!msg || msg.role !== "user") return false;
  if (msg.tool_calls) return false;
  return !normalizeContentToText(msg.content).trim().startsWith("<system>");
}

function findLatestRealUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessageForTimeline(messages[index])) return messages[index];
  }
  return null;
}

module.exports = {
  getTextFromContentPart,
  isImageContentPart,
  isFileContentPart,
  normalizeContentToText,
  parseTimestampLabel,
  makeFingerprint,
  makeFingerprintStripped,
  getTimestampFromMemory,
  isRealUserMessageForTimeline,
  findLatestRealUserMessage
};
