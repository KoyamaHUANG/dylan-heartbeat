const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-lifecycle-"));
const requestyUrl = "https://requesty-lifecycle.invalid/v1/chat/completions";
const gatewayBaseUrl = "http://gateway-lifecycle.test";

process.env.DATA_DIR = dataDirectory;
process.env.TARGET_API_URL = requestyUrl;
process.env.TARGET_API_KEY = "lifecycle-test-key";
process.env.MODEL_NAME = "anthropic/claude-sonnet-4-6";
process.env.GATEWAY_BASE_URL = gatewayBaseUrl;
process.env.BARK_KEY = "lifecycle-bark-key";
process.env.PUSH_PROVIDER = "bark";
process.env.PUSH_DISPLAY_NAME = "阿言";
process.env.CUSTOM_ICON_URL = "https://example.invalid/ayan-avatar.jpg";
process.env.WEATHER_ENABLED = "false";
process.env.DIARY_ENABLED = "true";
process.env.DAY_WAKE_AFTER_MINUTES = "1";
process.env.NIGHT_WAKE_AFTER_MINUTES = "1";
process.env.WAKE_DAY_START_HOUR = "0";
process.env.WAKE_DAY_END_HOUR = "24";

const { app } = require("../server");
const { runWakeUp } = require("../wake_up");
const { makeFingerprint, makeFingerprintStripped } = require("../timestamp_memory");
const { isSpecialEventContent } = require("../special_events");

const originalFetch = global.fetch;
const upstreamRequests = [];
const barkPayloads = [];
const wakeEventRequests = [];
const modelReplies = [];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function enqueueModelReply(content) {
  modelReplies.push({ choices: [{ message: { role: "assistant", content } }] });
}

function writeRuntimeFile(name, value) {
  fs.writeFileSync(path.join(dataDirectory, name), JSON.stringify(value, null, 2), "utf8");
}

function readRuntimeFile(name, fallback) {
  const filePath = path.join(dataDirectory, name);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
}

function resetRuntimeState(timeline = [], timestampDB = {}) {
  writeRuntimeFile("enhanced_messages.json", timeline);
  writeRuntimeFile("message_timestamps.json", timestampDB);
  fs.rmSync(path.join(dataDirectory, "diary"), { recursive: true, force: true });
}

function setRememberedTime(message, date) {
  const timestampDB = readRuntimeFile("message_timestamps.json", {});
  const iso = new Date(date).toISOString();
  timestampDB[makeFingerprint(message)] = iso;
  timestampDB[makeFingerprintStripped(message)] = iso;
  writeRuntimeFile("message_timestamps.json", timestampDB);
}

async function chat(messages) {
  enqueueModelReply("normal chat response");
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "test-model", stream: false, messages }
  });
  assert.equal(response.statusCode, 200);
  return upstreamRequests.at(-1);
}

function latestSpecialEvent() {
  return readRuntimeFile("enhanced_messages.json", []).find(message =>
    message.role === "assistant" && isSpecialEventContent(message.content)
  );
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
    return jsonResponse(200, { code: 200, message: "success" });
  }
  if (target === `${gatewayBaseUrl}/internal/wake-event`) {
    wakeEventRequests.push(JSON.parse(options.body));
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

test("Gateway、wake-up、Bark、wake event 与后续聊天保持连续且上游最后一条为 user", async () => {
  const system = { role: "system", content: "系统设定" };
  const user1 = { role: "user", content: "第一条用户消息" };
  const assistant1 = { role: "assistant", content: "第一条正常回答" };
  const user2 = { role: "user", content: "第二条用户消息", position: 999, created_at: "internal" };

  // A. 普通聊天：即使输入含内部字段，真正上游请求仍以 user2 结束且不会泄漏字段。
  resetRuntimeState();
  const firstRequest = await chat([system, user1, assistant1, user2]);
  assert.equal(firstRequest.messages.at(-1).content, user2.content);
  assert.equal(firstRequest.messages.at(-1).role, "user");
  for (const message of firstRequest.messages) {
    assert.deepEqual(Object.keys(message).sort(), Object.keys(message).filter(key =>
      ["role", "content", "name", "tool_calls", "tool_call_id"].includes(key)
    ).sort());
  }

  // B. 静置后正常 wake-up：Bark 成功、wake event 经过真实内部路由，并即时建立 timestamp memory。
  setRememberedTime(user2, Date.now() - 5 * 60 * 1000);
  const barkCountBeforeWake = barkPayloads.length;
  const wakeEventCountBeforeWake = wakeEventRequests.length;
  enqueueModelReply("想你了，在忙吗？");
  await runWakeUp();
  assert.equal(barkPayloads.length, barkCountBeforeWake + 1);
  assert.equal(wakeEventRequests.length, wakeEventCountBeforeWake + 1);
  const wakeEvent = latestSpecialEvent();
  assert.ok(wakeEvent);
  const wakeTimestampDB = readRuntimeFile("message_timestamps.json", {});
  assert.ok(wakeTimestampDB[makeFingerprint(wakeEvent)]);
  assert.ok(wakeTimestampDB[makeFingerprintStripped(wakeEvent)]);

  // C. 同一临时运行数据继续：用户回到 Kelivo 后，事件保留但在 user3 之前，绝不 assistant prefill。
  const user3 = { role: "user", content: "第三条用户消息" };
  const returnRequest = await chat([system, user1, assistant1, user2, user3]);
  const injectedEventIndex = returnRequest.messages.findIndex(message => message.content === wakeEvent.content);
  assert.ok(injectedEventIndex >= 0);
  assert.ok(injectedEventIndex < returnRequest.messages.length - 1);
  assert.equal(returnRequest.messages.at(-1).content, user3.content);
  assert.equal(returnRequest.messages.at(-1).role, "user");
  const persistedReturnTimeline = readRuntimeFile("enhanced_messages.json", []);
  const persistedEventIndex = persistedReturnTimeline.findIndex(message => message.content === wakeEvent.content);
  const persistedUser3Index = persistedReturnTimeline.findIndex(message => message.content === user3.content);
  assert.ok(persistedEventIndex >= 0 && persistedEventIndex < persistedUser3Index);

  // D. 单个无 timestamp memory 的旧 HH:mm 事件保留在新 user 之前。
  const singleLegacyEvent = { role: "assistant", content: "（22:20 刚刚给用户发了 Bark 推送：单个旧事件）" };
  resetRuntimeState([system, singleLegacyEvent], {});
  const singleLegacyUser = { role: "user", content: "单个旧事件后的新消息" };
  const singleLegacyRequest = await chat([system, singleLegacyUser]);
  const singleLegacyIndex = singleLegacyRequest.messages.findIndex(message => message.content === singleLegacyEvent.content);
  assert.ok(singleLegacyIndex >= 0 && singleLegacyIndex < singleLegacyRequest.messages.length - 1);
  assert.equal(singleLegacyRequest.messages.at(-1).role, "user");

  // E. 多个无 timestamp memory 的旧 HH:mm 事件也全部保留在新 user 之前。
  const legacyEvents = [
    "（22:20 刚刚给用户发了 Bark 推送：旧事件一）",
    "（22:21 自动唤醒：本次未发送推送）",
    "（22:22 刚刚给用户发了 Bark 推送：旧事件三）"
  ].map(content => ({ role: "assistant", content }));
  resetRuntimeState([system, ...legacyEvents], {});
  const legacyUser = { role: "user", content: "处理旧事件后的新消息" };
  const legacyRequest = await chat([system, legacyUser]);
  for (const legacyEvent of legacyEvents) {
    const index = legacyRequest.messages.findIndex(message => message.content === legacyEvent.content);
    assert.ok(index >= 0);
    assert.ok(index < legacyRequest.messages.length - 1);
  }
  assert.equal(legacyRequest.messages.at(-1).role, "user");

  // F. 有 memory 的 special event 按真实时间插入两条 user 消息之间。
  const timedUser1 = { role: "user", content: "较早用户消息" };
  const timedUser2 = { role: "user", content: "较晚用户消息" };
  const timedEvent = { role: "assistant", content: "（22:23 刚刚给用户发了 Bark 推送：有记忆事件）" };
  const baseTime = Date.now();
  resetRuntimeState([system, timedEvent], {});
  setRememberedTime(timedUser1, baseTime - 10 * 60 * 1000);
  setRememberedTime(timedEvent, baseTime - 5 * 60 * 1000);
  setRememberedTime(timedUser2, baseTime - 1 * 60 * 1000);
  const timedRequest = await chat([system, timedUser1, timedUser2]);
  const firstTimedUserIndex = timedRequest.messages.findIndex(message => message.content === timedUser1.content);
  const timedEventIndex = timedRequest.messages.findIndex(message => message.content === timedEvent.content);
  const secondTimedUserIndex = timedRequest.messages.findIndex(message => message.content === timedUser2.content);
  assert.ok(firstTimedUserIndex < timedEventIndex && timedEventIndex < secondTimedUserIndex);
  assert.equal(timedRequest.messages.at(-1).role, "user");

  // G. [NO_ACTION] 仍记录事件但不 Bark；下一次聊天不产生 assistant prefill。
  const silentUser = { role: "user", content: "静默 wake 的用户消息" };
  resetRuntimeState([system, silentUser], {});
  setRememberedTime(silentUser, Date.now() - 5 * 60 * 1000);
  const barkCountBeforeSilent = barkPayloads.length;
  enqueueModelReply("[NO_ACTION]");
  await runWakeUp();
  assert.equal(barkPayloads.length, barkCountBeforeSilent);
  assert.ok(latestSpecialEvent());
  const silentReturnRequest = await chat([system, silentUser, { role: "user", content: "静默后继续聊天" }]);
  assert.equal(silentReturnRequest.messages.at(-1).role, "user");

  // H. [DIARY] 在启用时写入、禁用时跳过；两种结果之后均可继续普通聊天。
  const diaryUser = { role: "user", content: "写日记的用户消息" };
  resetRuntimeState([system, diaryUser], {});
  setRememberedTime(diaryUser, Date.now() - 5 * 60 * 1000);
  process.env.DIARY_ENABLED = "true";
  enqueueModelReply("[DIARY]测试日记[/DIARY]\n[NO_ACTION]");
  await runWakeUp();
  assert.equal(fs.readdirSync(path.join(dataDirectory, "diary")).length, 1);
  const diaryReturnRequest = await chat([system, diaryUser, { role: "user", content: "日记后继续聊天" }]);
  assert.equal(diaryReturnRequest.messages.at(-1).role, "user");

  resetRuntimeState([system, diaryUser], {});
  setRememberedTime(diaryUser, Date.now() - 5 * 60 * 1000);
  process.env.DIARY_ENABLED = "false";
  enqueueModelReply("[DIARY]不应保存的日记[/DIARY]\n[NO_ACTION]");
  await runWakeUp();
  assert.equal(fs.existsSync(path.join(dataDirectory, "diary")), false);
  const disabledDiaryReturnRequest = await chat([system, diaryUser, { role: "user", content: "关闭日记后继续聊天" }]);
  assert.equal(disabledDiaryReturnRequest.messages.at(-1).role, "user");
  process.env.DIARY_ENABLED = "true";

  // I. 连续两次 wake-up 不会损坏 timeline；每个事件只注入一次，后续 user 仍是最后一条。
  const repeatedWakeUser = { role: "user", content: "连续唤醒的用户消息" };
  resetRuntimeState([system, repeatedWakeUser], {});
  setRememberedTime(repeatedWakeUser, Date.now() - 5 * 60 * 1000);
  enqueueModelReply("第一次连续唤醒");
  enqueueModelReply("第二次连续唤醒");
  await runWakeUp();
  await runWakeUp();
  const repeatedEvents = readRuntimeFile("enhanced_messages.json", []).filter(message => isSpecialEventContent(message.content));
  assert.equal(repeatedEvents.length, 2);
  assert.equal(new Set(repeatedEvents.map(message => message.content)).size, 2);
  const repeatedReturnRequest = await chat([system, repeatedWakeUser, { role: "user", content: "连续唤醒后继续聊天" }]);
  assert.equal(repeatedReturnRequest.messages.at(-1).role, "user");
  for (const event of repeatedEvents) {
    assert.equal(repeatedReturnRequest.messages.filter(message => message.content === event.content).length, 1);
  }
});
