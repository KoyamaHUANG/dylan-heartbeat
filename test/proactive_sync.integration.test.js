const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-proactive-sync-"));
const requestyUrl = "https://requesty-proactive-sync.invalid/v1/chat/completions";
const gatewayBaseUrl = "http://gateway-proactive-sync.test";
const gatewayKey = "proactive-sync-gateway-key";

process.env.DATA_DIR = dataDirectory;
process.env.RAILWAY_ENVIRONMENT = "test";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = gatewayKey;
process.env.TARGET_API_URL = requestyUrl;
process.env.TARGET_API_KEY = "proactive-sync-upstream-key";
process.env.MODEL_NAME = "anthropic/claude-sonnet-4-6";
process.env.GATEWAY_BASE_URL = gatewayBaseUrl;
process.env.BARK_KEY = "proactive-sync-bark-key";
process.env.PUSH_PROVIDER = "bark";
process.env.PUSH_DISPLAY_NAME = "阿言";
process.env.WEATHER_ENABLED = "false";
process.env.DIARY_ENABLED = "true";
process.env.DAY_WAKE_AFTER_MINUTES = "1";
process.env.NIGHT_WAKE_AFTER_MINUTES = "1";
process.env.DAY_CHECK_INTERVAL_MINUTES = "1";
process.env.NIGHT_CHECK_INTERVAL_MINUTES = "1";
process.env.WAKE_DAY_START_HOUR = "0";
process.env.WAKE_DAY_END_HOUR = "24";
process.env.PROACTIVE_SYNC_TEST_ENABLED = "false";

const { app } = require("../server");
const { runWakeUp, scheduleNextCheck } = require("../wake_up");
const { makeFingerprint, makeFingerprintStripped } = require("../timestamp_memory");
const { loadKelivoSyncContext } = require("../kelivo_sync_context");
const { loadProactiveStore } = require("../proactive_events");
const { isSpecialEventContent } = require("../special_events");

const originalFetch = global.fetch;
const upstreamRequests = [];
const barkPayloads = [];
const wakeEventPayloads = [];
const modelReplies = [];
let barkShouldFail = false;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function enqueueModelReply(content) {
  modelReplies.push({ choices: [{ message: { role: "assistant", content } }] });
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(dataDirectory, name), JSON.stringify(value, null, 2), "utf8");
}

function readJson(name, fallback) {
  const filePath = path.join(dataDirectory, name);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
}

function removeRuntimeFile(name) {
  fs.rmSync(path.join(dataDirectory, name), { force: true });
}

function setRememberedTime(message, date = Date.now() - 5 * 60 * 1000) {
  const db = readJson("message_timestamps.json", {});
  const iso = new Date(date).toISOString();
  db[makeFingerprint(message)] = iso;
  db[makeFingerprintStripped(message)] = iso;
  writeJson("message_timestamps.json", db);
}

function resetRuntimeState() {
  for (const fileName of [
    "enhanced_messages.json",
    "message_timestamps.json",
    "proactive_events.json",
    "kelivo_sync_context.json"
  ]) removeRuntimeFile(fileName);
  fs.rmSync(path.join(dataDirectory, "diary"), { recursive: true, force: true });
}

function publicHeaders(extra = {}) {
  return { authorization: `Bearer ${gatewayKey}`, ...extra };
}

async function publicInject(options) {
  return app.inject({
    ...options,
    remoteAddress: "10.0.0.8",
    headers: options.headers || {}
  });
}

async function chat(messages, headers = {}) {
  enqueueModelReply("normal chat response");
  const response = await publicInject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: publicHeaders(headers),
    payload: { model: "test-model", stream: false, messages }
  });
  assert.equal(response.statusCode, 200);
  return response;
}

global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target === requestyUrl) {
    upstreamRequests.push(JSON.parse(options.body));
    const reply = modelReplies.shift();
    assert.ok(reply, "unexpected Requesty request without a queued response");
    return jsonResponse(200, reply);
  }
  if (target === "https://api.day.app/push") {
    barkPayloads.push(JSON.parse(options.body));
    return barkShouldFail
      ? jsonResponse(500, { code: 500, message: "Bark failed" })
      : jsonResponse(200, { code: 200, message: "success" });
  }
  if (target === `${gatewayBaseUrl}/internal/wake-event`) {
    wakeEventPayloads.push(JSON.parse(options.body));
    const response = await app.inject({
      method: "POST",
      url: "/internal/wake-event",
      payload: JSON.parse(options.body)
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": "application/json" }
    });
  }
  throw new Error(`unexpected fetch URL: ${target}`);
};

test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("proactive API、conversation binding 与 wake-up 同步保持隔离且连续", async () => {
  const system = { role: "system", content: "系统设定" };
  const user = { role: "user", content: "带会话绑定的真实用户消息" };
  resetRuntimeState();

  // G. 真正 user turn + Header 才建立 conversation binding。
  await chat([system, user], {
    "x-kelivo-conversation-id": "conversation-A",
    "x-kelivo-assistant-id": "ayan"
  });
  const boundContext = loadKelivoSyncContext();
  assert.equal(boundContext.conversation_id, "conversation-A");
  assert.equal(boundContext.assistant_id, "ayan");
  assert.equal(boundContext.latest_user_fingerprint, makeFingerprint(user));
  assert.ok(boundContext.updated_at);

  // H / I. 无 Header 兼容旧 Kelivo；assistant/tool/system 请求不能切换既有绑定。
  fs.writeFileSync(path.join(dataDirectory, "proactive_events.json"), "{bad store", "utf8");
  await chat([system, { role: "user", content: "旧 Kelivo 继续聊天" }]);
  assert.equal(loadKelivoSyncContext().conversation_id, "conversation-A");
  await chat([system, { role: "assistant", content: "不是新用户回合" }], {
    "x-kelivo-conversation-id": "conversation-B",
    "x-kelivo-assistant-id": "other"
  });
  assert.equal(loadKelivoSyncContext().conversation_id, "conversation-A");
  await chat([system, { role: "tool", tool_call_id: "tool-1", content: "工具结果" }], {
    "x-kelivo-conversation-id": "conversation-B"
  });
  await chat([{ role: "system", content: "仅系统消息" }], {
    "x-kelivo-conversation-id": "conversation-B"
  });
  assert.equal(loadKelivoSyncContext().conversation_id, "conversation-A");
  const invalidHeaderResponse = await publicInject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: publicHeaders({ "x-kelivo-conversation-id": "bad\nconversation" }),
    payload: { model: "test-model", stream: false, messages: [system, user] }
  });
  assert.equal(invalidHeaderResponse.statusCode, 400);

  // R. 公网 proactive API 复用 Gateway Key；internal write 路径仍不允许公网访问。
  const noKey = await publicInject({ method: "GET", url: "/v1/proactive-events?conversation_id=conversation-A", headers: {} });
  const wrongKey = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-A",
    headers: { authorization: "Bearer wrong" }
  });
  const correctKey = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-A",
    headers: publicHeaders()
  });
  const externalInternalWrite = await publicInject({
    method: "POST",
    url: "/internal/wake-event",
    headers: publicHeaders(),
    payload: { content: "（2026-08-22 12:00 自动唤醒：本次未发送推送）" }
  });
  assert.equal(noKey.statusCode, 401);
  assert.equal(wrongKey.statusCode, 401);
  assert.equal(correctKey.statusCode, 200);
  assert.equal(externalInternalWrite.statusCode, 403);
  const missingConversation = await publicInject({ method: "GET", url: "/v1/proactive-events", headers: publicHeaders() });
  assert.equal(missingConversation.statusCode, 400);
  const invalidCursor = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-A&after_seq=-1",
    headers: publicHeaders()
  });
  const invalidLimit = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-A&limit=101",
    headers: publicHeaders()
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(invalidLimit.statusCode, 400);

  // O. 手工测试端点默认 404；打开开关后只创建 inbox event，不触发模型、Bark 或 timeline。
  const timelineBeforeManualTest = fs.readFileSync(path.join(dataDirectory, "enhanced_messages.json"), "utf8");
  const upstreamBeforeManualTest = upstreamRequests.length;
  const barkBeforeManualTest = barkPayloads.length;
  const disabledManual = await publicInject({
    method: "POST",
    url: "/v1/proactive-events/test",
    headers: publicHeaders(),
    payload: { conversation_id: "conversation-A", body: "手工测试" }
  });
  assert.equal(disabledManual.statusCode, 404);
  process.env.PROACTIVE_SYNC_TEST_ENABLED = "true";
  const invalidManual = await publicInject({
    method: "POST",
    url: "/v1/proactive-events/test",
    headers: publicHeaders(),
    payload: { conversation_id: "conversation-A", body: "" }
  });
  assert.equal(invalidManual.statusCode, 400);
  const enabledManual = await publicInject({
    method: "POST",
    url: "/v1/proactive-events/test",
    headers: publicHeaders(),
    payload: { conversation_id: "conversation-A", assistant_id: "ayan", body: "手工同步测试" }
  });
  assert.equal(enabledManual.statusCode, 201);
  assert.equal(JSON.parse(enabledManual.body).source, "manual_test");
  assert.equal(JSON.parse(enabledManual.body).push_provider, "none");
  assert.equal(upstreamRequests.length, upstreamBeforeManualTest);
  assert.equal(barkPayloads.length, barkBeforeManualTest);
  assert.equal(fs.readFileSync(path.join(dataDirectory, "enhanced_messages.json"), "utf8"), timelineBeforeManualTest);
  process.env.PROACTIVE_SYNC_TEST_ENABLED = "false";
  removeRuntimeFile("proactive_events.json");

  // J. Bark 成功后，wake event 仍写 timeline，同时创建绑定到 conversation-A 的主动事件。
  const wakeUser = { role: "user", content: "等待主动消息的用户" };
  writeJson("enhanced_messages.json", [system, wakeUser]);
  writeJson("message_timestamps.json", {});
  setRememberedTime(wakeUser);
  barkShouldFail = false;
  enqueueModelReply("想你了，在忙吗？");
  await runWakeUp();
  const successfulBark = barkPayloads.at(-1);
  assert.equal(successfulBark.title, "阿言");
  assert.equal(successfulBark.body, "想你了，在忙吗？");
  const successfulWakeEventPayload = wakeEventPayloads.at(-1);
  assert.deepEqual(successfulWakeEventPayload.proactive, {
    title: successfulBark.title,
    body: successfulBark.body,
    provider: "bark",
    sent_at: successfulWakeEventPayload.proactive.sent_at
  });
  assert.ok(!Number.isNaN(new Date(successfulWakeEventPayload.proactive.sent_at).getTime()));
  const wakeTimeline = readJson("enhanced_messages.json", []);
  assert.ok(wakeTimeline.some(message => isSpecialEventContent(message.content)));
  const wakeStore = loadProactiveStore();
  assert.equal(wakeStore.events.length, 1);
  assert.deepEqual(wakeStore.events[0], {
    ...wakeStore.events[0],
    conversation_id: "conversation-A",
    assistant_id: "ayan",
    role: "assistant",
    title: successfulBark.title,
    body: successfulBark.body,
    source: "wake",
    push_provider: "bark"
  });

  // C / D / E / F / P. 拉取只按 conversation 与 cursor 过滤，多个客户端重复读取不会改变 store。
  const firstRead = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-A&after_seq=0&limit=1",
    headers: publicHeaders()
  });
  const firstPayload = JSON.parse(firstRead.body);
  assert.equal(firstRead.statusCode, 200);
  assert.equal(firstPayload.object, "proactive_event_list");
  assert.equal(firstPayload.data.length, 1);
  assert.equal(firstPayload.data[0].event_id, wakeStore.events[0].event_id);
  const countBeforeRepeatedReads = loadProactiveStore().events.length;
  for (let index = 0; index < 10; index += 1) {
    const repeated = await publicInject({
      method: "GET",
      url: "/v1/proactive-events?conversation_id=conversation-A&after_seq=0",
      headers: publicHeaders()
    });
    assert.equal(JSON.parse(repeated.body).data[0].event_id, wakeStore.events[0].event_id);
  }
  assert.equal(loadProactiveStore().events.length, countBeforeRepeatedReads);
  const isolatedRead = await publicInject({
    method: "GET",
    url: "/v1/proactive-events?conversation_id=conversation-B&after_seq=0",
    headers: publicHeaders()
  });
  assert.deepEqual(JSON.parse(isolatedRead.body).data, []);

  // K / L. [NO_ACTION] 与只写日记仍记录原 special event，但不创建 proactive inbox event。
  const countBeforeSilentWake = loadProactiveStore().events.length;
  enqueueModelReply("[NO_ACTION]");
  await runWakeUp();
  assert.equal(Object.hasOwn(wakeEventPayloads.at(-1), "proactive"), false);
  enqueueModelReply("[DIARY]只写日记[/DIARY]");
  await runWakeUp();
  assert.equal(Object.hasOwn(wakeEventPayloads.at(-1), "proactive"), false);
  assert.equal(loadProactiveStore().events.length, countBeforeSilentWake);
  assert.ok(fs.existsSync(path.join(dataDirectory, "diary")));

  // M. Bark 失败不创建 event，wake scheduler 仍会安排下一次检查。
  barkShouldFail = true;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return { unref() {} };
  };
  enqueueModelReply("这次 Bark 会失败");
  try {
    await scheduleNextCheck();
  } finally {
    global.setTimeout = originalSetTimeout;
    barkShouldFail = false;
  }
  assert.equal(Object.hasOwn(wakeEventPayloads.at(-1), "proactive"), false);
  assert.equal(loadProactiveStore().events.length, countBeforeSilentWake);
  assert.ok(readJson("enhanced_messages.json", []).some(message => isSpecialEventContent(message.content)));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60_000);

  // N. 缺少 conversation binding 时，Bark 和 special event 保持成功，但 inbox 不写入任何猜测会话。
  removeRuntimeFile("kelivo_sync_context.json");
  const countBeforeMissingContext = loadProactiveStore().events.length;
  enqueueModelReply("没有绑定也能正常推送");
  await runWakeUp();
  assert.equal(loadProactiveStore().events.length, countBeforeMissingContext);
  assert.equal(barkPayloads.at(-1).body, "没有绑定也能正常推送");
});
