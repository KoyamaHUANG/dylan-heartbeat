const { localDateRangeToUtc } = require("../time_utils");
const { createArchiveCursor, parseArchiveCursor } = require("./archive_cursor");

function queryError(message) {
  const error = new Error(message);
  error.code = "ARCHIVE_QUERY_INVALID";
  return error;
}

function parseArchiveLimit(value) {
  if (value == null || value === "") return 100;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw queryError("limit must be an integer between 1 and 500");
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw queryError("limit must be an integer between 1 and 500");
  return limit;
}

function parseArchiveBoolean(value, field) {
  if (value == null || value === "") return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw queryError(`${field} must be true or false`);
}

function parseArchiveQuery(query = {}, { timeZone, archiveApiKey } = {}) {
  const conversation_id = typeof query.conversation_id === "string" ? query.conversation_id.trim() : "";
  if (!conversation_id || conversation_id.length > 128 || /[\u0000-\u001F\u007F]/.test(conversation_id)) {
    throw queryError("conversation_id is invalid");
  }
  const date = query.date == null || query.date === "" ? null : String(query.date);
  const dateRange = date ? localDateRangeToUtc(date, timeZone) : null;
  if (date && !dateRange) throw queryError("date must be a valid YYYY-MM-DD");
  const limit = parseArchiveLimit(query.limit);
  const include_duplicates = parseArchiveBoolean(query.include_duplicates, "include_duplicates");
  const cursor = query.cursor == null || query.cursor === ""
    ? null
    : parseArchiveCursor(String(query.cursor), archiveApiKey, { conversation_id, date, include_duplicates });
  return { conversation_id, date, dateRange, limit, include_duplicates, cursor };
}

function archiveRouteError(reply, error) {
  if (["ARCHIVE_QUERY_INVALID", "ARCHIVE_CURSOR_INVALID", "ARCHIVE_VALIDATION"].includes(error?.code)) {
    return reply.code(400).send({ error: "Invalid archive query" });
  }
  if (error?.code === "ARCHIVE_DISABLED") return reply.code(503).send({ error: "Archive unavailable" });
  return reply.code(503).send({ error: "Archive unavailable" });
}

function registerArchiveRoutes(app, { archiveService, timeZone, archiveApiKey = process.env.ARCHIVE_API_KEY, logger = console } = {}) {
  app.get("/v1/archive/messages", async (req, reply) => {
    try {
      const query = parseArchiveQuery(req.query || {}, { timeZone, archiveApiKey });
      const [page, stats] = await Promise.all([
        archiveService.listMessages(query),
        archiveService.stats(query)
      ]);
      const last = page.messages.at(-1);
      const next_cursor = page.has_more && last
        ? createArchiveCursor({
          conversation_id: query.conversation_id,
          date: query.date,
          include_duplicates: query.include_duplicates,
          sequence: last.sequence,
          id: last.id
        }, archiveApiKey)
        : null;
      reply.send({
        date: query.date,
        timezone: timeZone,
        conversation_id: query.conversation_id,
        total: stats.total,
        user_count: stats.user_count,
        assistant_count: stats.assistant_count,
        unresolved_identity_conflicts: stats.unresolved_identity_conflicts,
        messages: page.messages.map(message => ({
          archive_message_id: message.archive_message_id,
          role: message.role,
          content: message.content_text,
          content_json: message.content_json,
          message_time: message.message_time,
          observed_at: message.observed_at,
          source: message.source,
          sequence: message.sequence,
          canonical: message.canonical,
          confirmed: message.confirmed,
          completion_status: message.completion_status,
          delivery_status: message.delivery_status,
          reconcile_status: message.reconcile_status
        })),
        next_cursor
      });
    } catch (error) {
      logger?.warn?.(JSON.stringify({ event: "archive_query_failed", error_category: error?.code || "archive_error" }));
      return archiveRouteError(reply, error);
    }
  });

  app.get("/v1/archive/stats", async (req, reply) => {
    try {
      const query = parseArchiveQuery(req.query || {}, { timeZone, archiveApiKey });
      const stats = await archiveService.stats(query);
      reply.send({ date: query.date, timezone: timeZone, ...stats });
    } catch (error) {
      logger?.warn?.(JSON.stringify({ event: "archive_stats_failed", error_category: error?.code || "archive_error" }));
      return archiveRouteError(reply, error);
    }
  });
}

module.exports = { parseArchiveBoolean, parseArchiveLimit, parseArchiveQuery, registerArchiveRoutes };
