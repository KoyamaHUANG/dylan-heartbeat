const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { newDb } = require("pg-mem");
const { ArchiveStore } = require("../archive/archive_store");
const { RawChatArchiveService, buildChatCaptureInput } = require("../archive/archive_sync");
const { validateArchiveIdentity } = require("../archive/archive_protocol");
const { archiveContent } = require("../archive/archive_content");
const { authorizeArchiveRequest } = require("../archive/archive_auth");
const { createArchiveCursor, parseArchiveCursor } = require("../archive/archive_cursor");
const { SseAssistantCollector } = require("../archive/archive_stream");

const observedAt = new Date("2026-08-30T15:08:04.000Z");

function silentLogger() { return { log() {}, warn() {} }; }

function makeArchive() {
  const db = newDb();
  for (const migration of ["001_initial.sql", "002_kelivo_archive_identity.sql"]) {
    db.public.none(fs.readFileSync(path.join(__dirname, "..", "migrations", migration), "utf8"));
  }
  const { Pool } = db.adapters.createPg();
  const store = new ArchiveStore({ pool: new Pool(), now: () => observedAt });
  store.migrated = true;
  return { store, service: new RawChatArchiveService({ enabled: true, store, logger: silentLogger() }) };
}

function archiveContentFor(text, extras = []) {
  return { format: "kelivo_chat_message_parts_v1", parts: [{ type: "text", text }, ...extras] };
}

function protocolRequest({
  conversationId = "conversation-A", assistantId = "ayan", requestId = "request-A",
  userMessageId = "message-A", text = "真实用户消息", messages = null, index = 0,
  time = "2026-08-30T15:08:03.000Z", content = null
} = {}) {
  const actualMessages = messages || [{ role: "user", content: text }];
  const body = {
    model: "test",
    messages: actualMessages,
    _kelivo_archive: {
      version: 1, kind: "user_send", conversation_id: conversationId,
      assistant_id: assistantId, request_id: requestId, user_message_id: userMessageId,
      user_message_index: index, user_message_time: time,
      user_archive_content: content || archiveContentFor(text)
    }
  };
  const headers = {
    "x-kelivo-archive-protocol": "1", "x-kelivo-conversation-id": conversationId,
    "x-kelivo-assistant-id": assistantId, "x-kelivo-request-id": requestId,
    "x-kelivo-user-message-id": userMessageId
  };
  return { body, headers };
}

function continuationRequest({ conversationId = "conversation-A", assistantId = "ayan", requestId = "request-A" } = {}) {
  return {
    body: {
      model: "test", messages: [{ role: "assistant", content: "" }, { role: "tool", content: "tool result", tool_call_id: "call_1" }],
      _kelivo_archive: { version: 1, kind: "continuation", conversation_id: conversationId, assistant_id: assistantId, request_id: requestId, parent_request_id: requestId }
    },
    headers: {
      "x-kelivo-archive-protocol": "1", "x-kelivo-conversation-id": conversationId,
      "x-kelivo-assistant-id": assistantId, "x-kelivo-request-id": requestId,
      "x-kelivo-parent-request-id": requestId
    }
  };
}

function captureInput(request) {
  const validated = validateArchiveIdentity(request);
  assert.equal(validated.valid, true, validated.reason);
  return buildChatCaptureInput({ archiveIdentity: validated.identity, observedAt });
}

async function listAll(service) {
  return service.listMessages({ conversation_id: "conversation-A", date: null, dateRange: null, limit: 100, cursor: null });
}

test("Protocol 1 identifies the persisted user despite synthetic role=user messages", () => {
  const request = protocolRequest({
    text: "本人输入",
    messages: [
      { role: "user", content: "synthetic memory before" },
      { role: "user", content: "本人输入" },
      { role: "user", content: "synthetic memory after" }
    ],
    index: 1
  });
  const validated = validateArchiveIdentity(request);
  assert.equal(validated.valid, true);
  assert.equal(validated.identity.user_message_index, 1);
  assert.equal(validated.identity.user_archive_content.parts[0].text, "本人输入");
});

test("Protocol validation rejects mismatched IDs, bad indexes, and envelope base64 fail-open", () => {
  const request = protocolRequest();
  request.headers["x-kelivo-user-message-id"] = "other-message";
  assert.match(validateArchiveIdentity(request).reason, /user_message_id_mismatch/);
  assert.match(validateArchiveIdentity(protocolRequest({ index: 3 })).reason, /user_message_index_invalid/);
  const base64 = protocolRequest({ content: archiveContentFor("photo", [{ type: "image", url: "data:image/png;base64,QUJD" }]) });
  assert.match(validateArchiveIdentity(base64).reason, /contains_base64/);
});

test("legacy role=user traffic creates no canonical archive history", async () => {
  const { service } = makeArchive();
  const legacy = validateArchiveIdentity({ headers: {}, body: { messages: [{ role: "user", content: "synthetic or unknown" }] } });
  assert.equal(legacy.valid, false);
  assert.equal(legacy.reason, "legacy_untrusted_user_identity");
  const capture = service.captureChatRequest(buildChatCaptureInput({ archiveIdentity: legacy.identity, observedAt }), { skipReason: legacy.reason });
  await capture.archiveAssistant("normal model reply");
  await service.flush();
  assert.equal((await listAll(service)).messages.length, 0);
  await service.close();
});

test("same request and user-message IDs are a deterministic transport retry", async () => {
  const { service } = makeArchive();
  const input = captureInput(protocolRequest({ requestId: "retry-request", userMessageId: "retry-message", text: "嗯" }));
  const first = service.captureChatRequest(input);
  const retry = service.captureChatRequest(input);
  await Promise.all([first.archiveAssistant("第一次结果"), retry.archiveAssistant("重复结果")]);
  await service.flush();
  assert.deepEqual((await listAll(service)).messages.map(row => row.content_text), ["嗯", "第一次结果"]);
  await service.close();
});

test("identical text with different Protocol 1 identities creates two canonical turns", async () => {
  const { service } = makeArchive();
  for (const [requestId, messageId, answer] of [["request-one", "message-one", "怎么啦"], ["request-two", "message-two", "我在"]]) {
    const capture = service.captureChatRequest(captureInput(protocolRequest({ requestId, userMessageId: messageId, text: "嗯" })));
    await capture.archiveAssistant(answer);
  }
  await service.flush();
  assert.deepEqual((await listAll(service)).messages.map(row => row.content_text), ["嗯", "怎么啦", "嗯", "我在"]);
  await service.close();
});

test("request/message identity reuse mismatches are retained as conflict audits", async () => {
  const { service, store } = makeArchive();
  const first = service.captureChatRequest(captureInput(protocolRequest({ requestId: "same-request", userMessageId: "message-one" })));
  await first.archiveAssistant("answer");
  const conflictA = service.captureChatRequest(captureInput(protocolRequest({ requestId: "same-request", userMessageId: "message-two", text: "other" })));
  await conflictA.archiveAssistant("must not attach");
  const conflictB = service.captureChatRequest(captureInput(protocolRequest({ requestId: "request-two", userMessageId: "message-one", text: "other again" })));
  await conflictB.archiveAssistant("must not attach either");
  await service.flush();
  const conflicts = await store.pool.query("SELECT reason FROM archive_reconciliation_conflicts ORDER BY observed_at, conflict_id");
  assert.deepEqual(conflicts.rows.map(row => row.reason).sort(), ["request_id_reused_with_different_user_message_id", "user_message_id_reused_with_different_request_id"]);
  assert.equal((await listAll(service)).unresolved_identity_conflicts, 2);
  await service.close();
});

test("tool continuation reuses the root turn and preserves final canonical assistant slot", async () => {
  const { service, store } = makeArchive();
  const initial = service.captureChatRequest(captureInput(protocolRequest({ requestId: "tool-root", userMessageId: "tool-user", text: "查天气" })));
  await initial.archiveAssistant({ content: "", intermediate: true, metadata_json: { structured_assistant: { tool_calls: [{ id: "call_1" }] } } });
  const continuation = service.captureChatRequest(captureInput(continuationRequest({ requestId: "tool-root" })));
  await continuation.archiveAssistant("今天晴天");
  await service.flush();
  assert.deepEqual((await listAll(service)).messages.map(row => row.content_text), ["查天气", "今天晴天"]);
  const phases = await store.pool.query("SELECT canonical, source FROM archive_messages WHERE source = 'gateway_assistant_tool_phase'");
  assert.deepEqual(phases.rows, [{ canonical: false, source: "gateway_assistant_tool_phase" }]);
  await service.close();
});

test("client message time is canonical while observed time remains separate", async () => {
  const { service } = makeArchive();
  const capture = service.captureChatRequest(captureInput(protocolRequest({ time: "2026-08-29T23:59:59.000-08:00" })));
  await capture.archiveAssistant("reply", { observedAt });
  await service.flush();
  const [user, assistant] = (await listAll(service)).messages;
  assert.equal(user.message_time, "2026-08-30T07:59:59.000Z");
  assert.equal(user.observed_at, observedAt.toISOString());
  assert.equal(assistant.observed_at, observedAt.toISOString());
  await service.close();
});

test("proactive events remain independently deduplicated", async () => {
  const { service } = makeArchive();
  const event = { conversation_id: "conversation-A", assistant_id: "ayan", external_event_id: "11111111-1111-4111-8111-111111111111", content: "主动消息", message_time: "2026-08-30T10:00:00.000Z" };
  await service.captureProactive(event);
  await service.captureProactive(event);
  assert.equal((await listAll(service)).messages.length, 1);
  await service.close();
});

test("archive sanitizer retains metadata without image base64", () => {
  const dataUrl = "data:image/png;base64," + "QUJD".repeat(1024);
  const archived = archiveContent({ parts: [{ type: "text", text: "caption" }, { url: dataUrl }] });
  assert.match(archived.content_text, /caption/);
  assert.equal(JSON.stringify(archived.content_json).includes(dataUrl), false);
});

test("archive auxiliary contracts remain strict", () => {
  assert.equal(authorizeArchiveRequest({}, "archive-key").status, 401);
  assert.equal(authorizeArchiveRequest({ authorization: "Bearer archive-key" }, "archive-key").allow, true);
  const cursor = createArchiveCursor({ conversation_id: "conversation-A", date: null, sequence: 3, id: 9 }, "archive-key");
  assert.deepEqual(parseArchiveCursor(cursor, "archive-key", { conversation_id: "conversation-A", date: null }), { v: 1, conversation_id: "conversation-A", date: null, sequence: 3, id: 9 });
  const collector = new SseAssistantCollector();
  collector.feed(Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"final\"}}]}\n\ndata: [DONE]\n\n"));
  assert.equal(collector.finish(), "final");
});
