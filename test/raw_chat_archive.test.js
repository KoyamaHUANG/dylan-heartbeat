const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { newDb } = require("pg-mem");
const { ArchiveStore } = require("../archive/archive_store");
const {
  RawChatArchiveService,
  buildChatCaptureInput,
  stableStringify
} = require("../archive/archive_sync");
const { archiveContent, contentFingerprint } = require("../archive/archive_content");
const { authorizeArchiveRequest } = require("../archive/archive_auth");
const { createArchiveCursor, parseArchiveCursor } = require("../archive/archive_cursor");
const { SseAssistantCollector } = require("../archive/archive_stream");
const { localDateRangeToUtc } = require("../time_utils");

function silentLogger() {
  return { log() {}, warn() {} };
}

function makeArchive({ now = () => new Date("2026-08-20T10:00:00.000Z") } = {}) {
  const db = newDb();
  // Execute the production PostgreSQL migration itself; pg-mem's pool adapter
  // rejects some otherwise-valid DDL constraint ASTs before execution.
  db.public.none(fs.readFileSync(path.join(__dirname, "..", "migrations", "001_initial.sql"), "utf8"));
  const { Pool } = db.adapters.createPg();
  const store = new ArchiveStore({ pool: new Pool(), now, retryWindowMs: 10 * 60 * 1000 });
  store.migrated = true;
  return { db, store, service: new RawChatArchiveService({ enabled: true, store, logger: silentLogger() }) };
}

function binding(conversation_id = "conversation-A", assistant_id = "ayan") {
  return { provided: true, conversation_id, assistant_id };
}

function captureInput(messages, options = {}) {
  return buildChatCaptureInput({
    binding: binding(options.conversation_id, options.assistant_id),
    messages,
    timestampDb: options.timestampDb || {},
    timeZone: options.timeZone || "Asia/Shanghai",
    observedAt: options.observedAt || new Date("2026-08-20T10:00:00.000Z")
  });
}

async function listAll(service, conversation_id = "conversation-A") {
  return service.listMessages({ conversation_id, date: null, dateRange: null, limit: 100, cursor: null });
}

test("archive disabled and missing database are no-op for chat capture", async () => {
  const disabled = new RawChatArchiveService({ enabled: false, logger: silentLogger() });
  const missingDatabase = new RawChatArchiveService({ enabled: true, databaseUrl: "", logger: silentLogger() });
  const messages = [{ role: "user", content: "正常聊天" }];
  const input = captureInput(messages);
  await disabled.captureChatRequest(input).archiveAssistant("回复");
  await missingDatabase.captureChatRequest(input).archiveAssistant("回复");
  await disabled.flush();
  await missingDatabase.flush();
});

test("first conversation seed preserves visible order and does not invent historical times", async () => {
  const { service } = makeArchive();
  const messages = [
    { role: "user", content: "昨天的第一句" },
    { role: "assistant", content: "昨天的回答" },
    { role: "user", content: "今天的新问题" }
  ];
  const capture = service.captureChatRequest(captureInput(messages));
  await capture.archiveAssistant("今天的正常回复");
  await service.flush();
  const page = await listAll(service);
  assert.deepEqual(page.messages.map(row => [row.role, row.source]), [
    ["user", "initial_context_seed"],
    ["assistant", "initial_context_seed"],
    ["user", "kelivo_live_user"],
    ["assistant", "gateway_assistant"]
  ]);
  assert.equal(page.messages[0].message_time, null);
  assert.equal(page.messages[1].message_time, null);
  assert.ok(page.messages[2].message_time.endsWith(".000Z"));
  await service.close();
});

test("empty user and assistant content are valid factual archive rows", async () => {
  const { service } = makeArchive();
  const capture = service.captureChatRequest(captureInput([{ role: "user", content: "" }]));
  await capture.archiveAssistant("");
  await service.flush();
  const page = await listAll(service);
  assert.deepEqual(page.messages.map(row => row.content_text), ["", ""]);
  await service.close();
});

test("rolling contexts reconcile, repeated short text remains separate, and retry is deduped", async () => {
  const { service } = makeArchive();
  const firstMessages = [
    { role: "user", content: "开场" },
    { role: "assistant", content: "好的" },
    { role: "user", content: "嗯" }
  ];
  const first = service.captureChatRequest(captureInput(firstMessages));
  await first.archiveAssistant("好的");
  const secondMessages = [...firstMessages, { role: "assistant", content: "好的" }, { role: "user", content: "嗯" }];
  const second = service.captureChatRequest(captureInput(secondMessages, { observedAt: new Date("2026-08-20T10:01:00.000Z") }));
  await second.archiveAssistant("好的", { observedAt: new Date("2026-08-20T10:01:01.000Z") });
  const retry = service.captureChatRequest(captureInput(secondMessages, { observedAt: new Date("2026-08-20T10:01:02.000Z") }));
  await retry.archiveAssistant("好的", { observedAt: new Date("2026-08-20T10:01:03.000Z") });
  await service.flush();
  const page = await listAll(service);
  assert.equal(page.messages.length, 6);
  assert.equal(page.messages.filter(row => row.role === "user" && row.content_text === "嗯").length, 2);
  assert.equal(page.messages.filter(row => row.role === "assistant" && row.content_text === "好的").length, 3);
  assert.deepEqual(page.messages.map(row => row.sequence), [1, 2, 3, 4, 5, 6]);
  await service.close();
});

test("a later rolling context reconciles an assistant missed before temporary archive failure", async () => {
  const { service } = makeArchive();
  const firstMessages = [
    { role: "user", content: "旧的第一句" },
    { role: "assistant", content: "旧的回答" },
    { role: "user", content: "第一句" }
  ];
  service.captureChatRequest(captureInput(firstMessages));
  await service.flush();
  const nextMessages = [
    { role: "user", content: "旧的第一句" },
    { role: "assistant", content: "旧的回答" },
    { role: "user", content: "第一句" },
    { role: "assistant", content: "漏存的回答" },
    { role: "user", content: "下一句" }
  ];
  const second = service.captureChatRequest(captureInput(nextMessages, { observedAt: new Date("2026-08-20T10:02:00.000Z") }));
  await second.archiveAssistant("新的回答");
  await service.flush();
  const page = await listAll(service);
  assert.equal(page.messages.find(row => row.content_text === "漏存的回答").source, "reconciled_context");
  assert.deepEqual(page.messages.map(row => row.content_text), ["旧的第一句", "旧的回答", "第一句", "漏存的回答", "下一句", "新的回答"]);
  await service.close();
});

test("proactive event ID dedupes while conversations remain isolated", async () => {
  const { service } = makeArchive();
  const input = {
    conversation_id: "conversation-A",
    assistant_id: "ayan",
    content: "我想你了",
    message_time: "2026-08-20T12:00:00.000Z",
    external_event_id: "11111111-1111-4111-8111-111111111111"
  };
  await service.captureProactive(input);
  await service.captureProactive(input);
  const secondConversation = service.captureChatRequest(captureInput([{ role: "user", content: "B 的聊天" }], { conversation_id: "conversation-B" }));
  await secondConversation.archiveAssistant("B 的回复");
  await service.flush();
  assert.equal((await listAll(service, "conversation-A")).messages.length, 1);
  assert.equal((await listAll(service, "conversation-B")).messages.length, 2);
  await service.close();
});

test("temporary archive database failure is contained and later recovery continues archiving", async () => {
  const { service, store } = makeArchive();
  const originalMigrate = store.migrate.bind(store);
  let unavailable = true;
  store.migrate = async () => {
    if (unavailable) throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
    return originalMigrate();
  };
  const failed = service.captureChatRequest(captureInput([{ role: "user", content: "数据库暂不可用" }]));
  await failed.archiveAssistant("仍应返回给聊天客户端");
  await service.flush();
  unavailable = false;
  const recovered = service.captureChatRequest(captureInput([{ role: "user", content: "恢复后的新消息" }]));
  await recovered.archiveAssistant("恢复后的回复");
  await service.flush();
  assert.deepEqual((await listAll(service)).messages.map(row => row.content_text), ["恢复后的新消息", "恢复后的回复"]);
  await service.close();
});

test("same rolling request from two devices is serialized into one archived turn", async () => {
  const { service } = makeArchive();
  const input = captureInput([{ role: "user", content: "同一台账请求" }]);
  const [first, second] = [service.captureChatRequest(input), service.captureChatRequest(input)];
  await Promise.all([first.archiveAssistant("同一回复"), second.archiveAssistant("同一回复")]);
  await service.flush();
  const page = await listAll(service);
  assert.deepEqual(page.messages.map(row => row.content_text), ["同一台账请求", "同一回复"]);
  await service.close();
});

test("date-filtered message and stats queries use UTC message times", async () => {
  const { service } = makeArchive();
  const capture = service.captureChatRequest(captureInput([{ role: "user", content: "日期边界" }], {
    observedAt: new Date("2026-08-19T16:30:00.000Z")
  }));
  await capture.archiveAssistant("同一天", { observedAt: new Date("2026-08-19T16:31:00.000Z") });
  await service.flush();
  const range = localDateRangeToUtc("2026-08-20", "Asia/Shanghai");
  const page = await service.listMessages({ conversation_id: "conversation-A", date: "2026-08-20", dateRange: range, limit: 100, cursor: null });
  const stats = await service.stats({ conversation_id: "conversation-A", dateRange: range });
  assert.equal(page.messages.length, 2);
  assert.equal(stats.total, 2);
  await service.close();
});

test("multimodal archive removes image base64 while preserving text and URL metadata", () => {
  const dataUrl = "data:image/png;base64," + "QUJD".repeat(1024);
  const archived = archiveContent([
    { type: "text", text: "中文 😊" },
    { type: "image_url", image_url: { url: dataUrl } },
    { type: "image_url", image_url: { url: "https://example.invalid/image.png" } }
  ]);
  const serialized = JSON.stringify(archived.content_json);
  assert.match(archived.content_text, /中文 😊/);
  assert.equal(serialized.includes(dataUrl), false);
  assert.match(serialized, /image_data_omitted/);
  assert.match(serialized, /https:\/\/example\.invalid\/image\.png/);
});

test("cursor is signed and bound to the requested conversation/date", () => {
  const cursor = createArchiveCursor({ conversation_id: "conversation-A", date: "2026-08-20", sequence: 4, id: 9 }, "archive-key");
  assert.deepEqual(parseArchiveCursor(cursor, "archive-key", { conversation_id: "conversation-A", date: "2026-08-20" }), {
    v: 1, conversation_id: "conversation-A", date: "2026-08-20", sequence: 4, id: 9
  });
  assert.throws(() => parseArchiveCursor(cursor, "wrong-key", { conversation_id: "conversation-A", date: "2026-08-20" }));
  assert.throws(() => parseArchiveCursor(cursor, "archive-key", { conversation_id: "conversation-B", date: "2026-08-20" }));
  assert.throws(() => parseArchiveCursor("payload.x", "archive-key", { conversation_id: "conversation-A", date: "2026-08-20" }));
});

test("configured time zone produces correct UTC date boundaries including DST", () => {
  const shanghai = localDateRangeToUtc("2026-08-20", "Asia/Shanghai");
  assert.equal(shanghai.start.toISOString(), "2026-08-19T16:00:00.000Z");
  assert.equal(shanghai.end.toISOString(), "2026-08-20T16:00:00.000Z");
  const spring = localDateRangeToUtc("2026-03-08", "America/New_York");
  assert.equal(spring.start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(spring.end.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(localDateRangeToUtc("2026-02-30", "Asia/Shanghai"), null);
});

test("SSE collector joins deltas without changing raw stream behavior", () => {
  const collector = new SseAssistantCollector();
  collector.feed(Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n"));
  collector.feed(Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DONE]\n\n"));
  assert.equal(collector.finish(), "你好");
});

test("archive API key is independent and strict bearer only", () => {
  assert.equal(authorizeArchiveRequest({}, "archive-key").status, 401);
  assert.equal(authorizeArchiveRequest({ authorization: "Bearer wrong" }, "archive-key").status, 401);
  assert.equal(authorizeArchiveRequest({ authorization: "Bearer archive-key" }, "archive-key").allow, true);
  assert.equal(authorizeArchiveRequest({ authorization: "Basic archive-key" }, "archive-key").status, 401);
});

test("stable request canonicalization is insensitive to object field order", () => {
  assert.equal(stableStringify({ b: 1, a: { z: 2, y: 3 } }), stableStringify({ a: { y: 3, z: 2 }, b: 1 }));
  assert.equal(
    contentFingerprint("user", { b: 1, a: { z: 2, y: 3 } }),
    contentFingerprint("user", { a: { y: 3, z: 2 }, b: 1 })
  );
});
