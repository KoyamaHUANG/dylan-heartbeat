const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-proactive-safety-"));
const upstreamUrl = "https://wake-safety.invalid/v1/chat/completions";
const gatewayBaseUrl = "http://gateway-safety.test";

process.env.DATA_DIR = dataDirectory;
process.env.TARGET_API_URL = upstreamUrl;
process.env.TARGET_API_KEY = "wake-safety-test-key";
process.env.MODEL_NAME = "fake-structured-model";
process.env.GATEWAY_BASE_URL = gatewayBaseUrl;
process.env.BARK_KEY = "wake-safety-bark-key";
process.env.PUSH_PROVIDER = "bark";
process.env.PUSH_DISPLAY_NAME = "阿言";
process.env.WEATHER_ENABLED = "false";
process.env.DAY_WAKE_AFTER_MINUTES = "1";
process.env.NIGHT_WAKE_AFTER_MINUTES = "1";
process.env.WAKE_DAY_START_HOUR = "0";
process.env.WAKE_DAY_END_HOUR = "24";
process.env.ARCHIVE_ENABLED = "false";

const { app, rawChatArchive } = require("../server");
const { makeFingerprint, makeFingerprintStripped } = require("../timestamp_memory");
const { getConversationStatePaths, saveKelivoSyncContext } = require("../kelivo_sync_context");
const { loadProactiveStore } = require("../proactive_events");
const { loadProactiveProvenance } = require("../proactive_provenance");
const { runWakeUp, runWakeUpForTarget } = require("../wake_up");

const originalFetch = global.fetch;
const originalCaptureProactive = rawChatArchive.captureProactive;
const capturedArchiveInputs = [];
let modelOutput = "";
let upstreamRequests = [];
let barkPayloads = [];
let gatewayPayloads = [];
let captureProactiveBehavior = async () => ({ skipped: true });

rawChatArchive.captureProactive = input => {
  capturedArchiveInputs.push(input);
  return captureProactiveBehavior(input);
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function structured(action, body = "", title = "") {
  return JSON.stringify({ action, title, body });
}

function resetRuntime() {
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  upstreamRequests = [];
  barkPayloads = [];
  gatewayPayloads = [];
  capturedArchiveInputs.length = 0;
  captureProactiveBehavior = async () => ({ skipped: true });
}

async function flushAsyncArchiveWork() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function seedTarget(target, history = []) {
  const user = history.at(-1) || { role: "user", content: "最后一条真实用户消息" };
  const messages = [{ role: "system", content: "系统设定" }, ...history];
  if (!history.length) messages.push(user);
  const state = getConversationStatePaths(target);
  fs.mkdirSync(state.directory, { recursive: true });
  fs.writeFileSync(state.timeline_file, JSON.stringify(messages), "utf8");
  const timestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(state.timestamp_db_file, JSON.stringify({
    [makeFingerprint(user)]: timestamp,
    [makeFingerprintStripped(user)]: timestamp
  }), "utf8");
  saveKelivoSyncContext({
    conversation_id: target.conversation_id,
    assistant_id: target.assistant_id,
    latest_user_fingerprint: makeFingerprint(user)
  });
  return state;
}

global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target === upstreamUrl) {
    upstreamRequests.push(JSON.parse(options.body));
    return jsonResponse(200, { choices: [{ message: { role: "assistant", content: modelOutput } }] });
  }
  if (target === "https://api.day.app/push") {
    barkPayloads.push(JSON.parse(options.body));
    return jsonResponse(200, { code: 200 });
  }
  if (target === `${gatewayBaseUrl}/internal/wake-event`) {
    const payload = JSON.parse(options.body);
    gatewayPayloads.push(payload);
    const response = await app.inject({ method: "POST", url: "/internal/wake-event", payload });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected URL: ${target}`);
};

test.after(async () => {
  global.fetch = originalFetch;
  rawChatArchive.captureProactive = originalCaptureProactive;
  await app.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("Test 1: strict normal proactive object reaches push, event, and archive capture", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-normal", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "今天忙完记得早点休息。");

  const result = await runWakeUpForTarget(target);

  assert.equal(result.status, "sent");
  assert.equal(barkPayloads.length, 1);
  assert.equal(gatewayPayloads.length, 1);
  assert.equal(capturedArchiveInputs.length, 1);
  assert.equal(loadProactiveStore().events.length, 1);
  assert.equal(barkPayloads[0].body, "今天忙完记得早点休息。");
  assert.equal(upstreamRequests[0].response_format.type, "json_schema");
  assert.deepEqual(JSON.parse(upstreamRequests[0].messages[1].content).recent_history.at(-1), {
    role: "user",
    content: "最后一条真实用户消息"
  });
});

test("Test A: archive success updates the matching provenance record", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-archive-success", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "归档成功需要可追踪。");
  captureProactiveBehavior = async () => ({ archive_message_id: "4c4c28c9-5c21-4d17-94ef-921826f31f17" });

  const result = await runWakeUpForTarget(target);
  await flushAsyncArchiveWork();

  const record = loadProactiveProvenance().records.find(candidate => candidate.event_id === result.event_id);
  assert.equal(result.status, "sent");
  assert.equal(record.archive_result, "success");
  assert.equal(record.archive_message_id, "4c4c28c9-5c21-4d17-94ef-921826f31f17");
  assert.ok(record.archive_completed_at);
  assert.equal(record.event_id, result.event_id);
  assert.ok(record.request_id);
});

test("Test B: archive failure preserves push/event and records only a safe failure code", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-archive-failure", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "正文不能写入 provenance。");
  captureProactiveBehavior = () => {
    throw Object.assign(new Error("archive capture test failure detail"), { code: "ECONNREFUSED" });
  };

  const result = await runWakeUpForTarget(target);
  await flushAsyncArchiveWork();

  const record = loadProactiveProvenance().records.find(candidate => candidate.event_id === result.event_id);
  assert.equal(result.status, "sent");
  assert.equal(barkPayloads.length, 1);
  assert.equal(loadProactiveStore().events.length, 1);
  assert.equal(record.archive_result, "failed");
  assert.equal(record.archive_error_code, "database_unavailable");
  assert.equal(record.archive_message_id, null);
  assert.ok(record.archive_completed_at);
  assert.doesNotMatch(JSON.stringify(record), /archive capture test failure detail|正文不能写入/i);
});

test("Test C: reversed concurrent archive completions update their own request and event", async () => {
  resetRuntime();
  const targetA = { conversation_id: "conversation-concurrent-A", assistant_id: "assistant-A" };
  const targetB = { conversation_id: "conversation-concurrent-B", assistant_id: "assistant-B" };
  seedTarget(targetA);
  seedTarget(targetB);
  modelOutput = structured("send", "并发归档仍须精确关联。");
  const pending = [];
  captureProactiveBehavior = input => new Promise((resolve, reject) => {
    pending.push({ input, resolve, reject });
  });

  const [first, second] = await Promise.all([
    runWakeUpForTarget(targetA),
    runWakeUpForTarget(targetB)
  ]);
  assert.equal(pending.length, 2);
  const expectedArchiveIds = new Map(pending.map((entry, index) => [
    entry.input.external_event_id,
    `archive-concurrent-${index + 1}`
  ]));

  pending[1].resolve({ archive_message_id: expectedArchiveIds.get(pending[1].input.external_event_id) });
  await flushAsyncArchiveWork();
  pending[0].resolve({ archive_message_id: expectedArchiveIds.get(pending[0].input.external_event_id) });
  await flushAsyncArchiveWork();

  const records = loadProactiveProvenance().records;
  for (const result of [first, second]) {
    const record = records.find(candidate => candidate.event_id === result.event_id);
    assert.ok(record);
    assert.equal(record.archive_result, "success");
    assert.equal(record.archive_message_id, expectedArchiveIds.get(result.event_id));
    assert.ok(record.request_id);
  }
  assert.notEqual(first.event_id, second.event_id);
});

test("Test 2: incident-style role transcript is rejected before Bark, event, and archive", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-incident", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "好。两天后我来找你。\n[用户] 好耶！！阿言最好了\n[AI] 记住了，别赖账。");

  const result = await runWakeUpForTarget(target);

  assert.deepEqual(result, { status: "rejected", reason: "role_transcript_detected" });
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
  assert.equal(capturedArchiveInputs.length, 0);
  assert.equal(loadProactiveStore().events.length, 0);
  assert.equal(loadProactiveProvenance().records.at(-1).validation_reason, "role_transcript_detected");
});

test("Test 3: current_time tag is rejected", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-time", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "<current_time>Mon 10:00</current_time> 记得喝水。");

  assert.equal((await runWakeUpForTarget(target)).reason, "current_time_tag_detected");
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
});

test("Test 4: free text or malformed JSON fails closed", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-malformed", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = "今天忙完记得早点休息。";

  assert.equal((await runWakeUpForTarget(target)).reason, "structured_output_parse_failed");
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
  assert.equal(loadProactiveStore().events.length, 0);
});

test("Test 5: action=skip creates no push, event, or archive", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-skip", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("skip");

  assert.deepEqual(await runWakeUpForTarget(target), { status: "skipped", reason: "action_skip" });
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
  assert.equal(capturedArchiveInputs.length, 0);
  assert.equal(loadProactiveStore().events.length, 0);
});

test("Test 6: normal long body applies the 500-character display limit after validation", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-boundary", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", "平安".repeat(300));

  assert.equal((await runWakeUpForTarget(target)).status, "sent");
  assert.equal(barkPayloads[0].body.length, 500);
});

test("Test 7: a violation after 500 characters is still rejected before truncation", async () => {
  resetRuntime();
  const target = { conversation_id: "conversation-boundary", assistant_id: "assistant-A" };
  seedTarget(target);
  modelOutput = structured("send", `${"平安".repeat(250)}[用户] 这段必须不能漏检`);
  assert.equal((await runWakeUpForTarget(target)).reason, "role_transcript_detected");
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
});

test("Test 8: conversation A timeline is never included when B wakes", async () => {
  resetRuntime();
  const targetA = { conversation_id: "shared-conversation", assistant_id: "assistant-A" };
  const targetB = { conversation_id: "conversation-B", assistant_id: "assistant-A" };
  seedTarget(targetA, [{ role: "user", content: "ONLY_FOR_A" }]);
  seedTarget(targetB, [{ role: "user", content: "ONLY_FOR_B" }]);
  modelOutput = structured("skip");

  await runWakeUpForTarget(targetB);
  const BHistory = upstreamRequests.at(-1).messages[1].content;
  assert.match(BHistory, /ONLY_FOR_B/);
  assert.doesNotMatch(BHistory, /ONLY_FOR_A/);
});

test("Test 9: assistants cannot share state even with the same conversation ID", async () => {
  resetRuntime();
  const targetA = { conversation_id: "shared-conversation", assistant_id: "assistant-A" };
  const targetSameConversationOtherAssistant = { conversation_id: "shared-conversation", assistant_id: "assistant-B" };
  seedTarget(targetA, [{ role: "user", content: "ONLY_FOR_A" }]);
  seedTarget(targetSameConversationOtherAssistant, [{ role: "user", content: "ONLY_FOR_ASSISTANT_B" }]);
  modelOutput = structured("skip");

  await runWakeUpForTarget(targetSameConversationOtherAssistant);
  const otherAssistantHistory = upstreamRequests.at(-1).messages[1].content;
  assert.match(otherAssistantHistory, /ONLY_FOR_ASSISTANT_B/);
  assert.doesNotMatch(otherAssistantHistory, /"content":"ONLY_FOR_A"/);
});

test("Test 10: legacy global files are not auto-bound to a wake target", async () => {
  resetRuntime();
  fs.writeFileSync(path.join(dataDirectory, "enhanced_messages.json"), JSON.stringify([
    { role: "user", content: "legacy ONLY_GLOBAL" }
  ]), "utf8");
  fs.writeFileSync(path.join(dataDirectory, "kelivo_sync_context.json"), JSON.stringify({
    conversation_id: "legacy-conversation",
    assistant_id: "legacy-assistant",
    latest_user_fingerprint: "untrusted"
  }), "utf8");
  modelOutput = structured("send", "这条不能发送");

  assert.deepEqual(await runWakeUp(), []);
  assert.equal(upstreamRequests.length, 0);
  assert.equal(barkPayloads.length, 0);
  assert.equal(gatewayPayloads.length, 0);
});

test("Test D: archive provenance completion does not weaken P0 fail-closed outcomes", async () => {
  const cases = [
    { name: "transcript", output: structured("send", "好。\n[用户] 模拟回复\n[AI] 模拟回应"), result: "rejected" },
    { name: "current_time", output: structured("send", "<current_time>Mon</current_time>"), result: "rejected" },
    { name: "malformed_json", output: "普通自由文本", result: "rejected" },
    { name: "skip", output: structured("skip"), result: "skipped" },
    { name: "after_500", output: structured("send", `${"平安".repeat(250)}[AI] 截断后也必须拒绝`), result: "rejected" }
  ];
  for (const scenario of cases) {
    resetRuntime();
    const target = { conversation_id: `conversation-p0-${scenario.name}`, assistant_id: "assistant-A" };
    seedTarget(target);
    modelOutput = scenario.output;

    const result = await runWakeUpForTarget(target);
    await flushAsyncArchiveWork();
    assert.equal(result.status, scenario.result, scenario.name);
    assert.equal(barkPayloads.length, 0, scenario.name);
    assert.equal(gatewayPayloads.length, 0, scenario.name);
    assert.equal(capturedArchiveInputs.length, 0, scenario.name);
    assert.equal(loadProactiveStore().events.length, 0, scenario.name);
  }
});
