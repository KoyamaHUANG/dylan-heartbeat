const ROLE_MARKER = /\[(?:用户|AI|user|assistant)\]/iu;
const CURRENT_TIME_TAG = /<\/?current_time\s*>/iu;
const ROLE_LINE = /^\s*(用户|AI|user|assistant)\s*[:：]\s*\S/iu;

function validationFailure(reason) {
  return { ok: false, reason };
}

// This deliberately targets only high-confidence transcript syntax. A normal
// Chinese notification may mention a user or an assistant, but must not look
// like a sequence of authored dialogue turns.
function validateProactiveBody(value) {
  if (typeof value !== "string") return validationFailure("body_not_string");
  const body = value.trim();
  if (!body) return validationFailure("body_empty");
  if (CURRENT_TIME_TAG.test(body)) return validationFailure("current_time_tag_detected");
  if (ROLE_MARKER.test(body)) return validationFailure("role_transcript_detected");

  const roleLines = body
    .split(/\r?\n/)
    .filter(line => ROLE_LINE.test(line));
  const distinctRoles = new Set(roleLines.map(line => line.match(ROLE_LINE)[1].toLowerCase()));
  if (distinctRoles.size >= 2) return validationFailure("role_transcript_detected");

  return { ok: true, reason: null };
}

module.exports = { validateProactiveBody };
