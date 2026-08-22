const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-wake-"));
const requestyUrl = "https://router.requesty.ai/v1/chat/completions";
const gatewayBaseUrl = "http://gateway-test.local";
const avatarUrl = "https://raw.githubusercontent.com/KoyamaHUANG/dylan-heartbeat/main/assets/ayan-avatar.jpg";
process.env.DATA_DIR = dataDirectory;
process.env.TARGET_API_URL = requestyUrl;
process.env.TARGET_API_KEY = "wake-test-key";
process.env.MODEL_NAME = "anthropic/claude-sonnet-4-6";
process.env.GATEWAY_BASE_URL = gatewayBaseUrl;
process.env.BARK_KEY = "wake-test-bark-key";
process.env.PUSH_PROVIDER = "bark";
process.env.PUSH_DISPLAY_NAME = "阿言";
process.env.CUSTOM_ICON_URL = avatarUrl;
process.env.WEATHER_ENABLED = "false";
process.env.DIARY_ENABLED = "true";
process.env.DAY_WAKE_AFTER_MINUTES = "1";
process.env.NIGHT_WAKE_AFTER_MINUTES = "1";
process.env.DAY_CHECK_INTERVAL_MINUTES = "1";
process.env.NIGHT_CHECK_INTERVAL_MINUTES = "1";
process.env.WAKE_DAY_START_HOUR = "0";
process.env.WAKE_DAY_END_HOUR = "24";

const { makeFingerprint } = require("../timestamp_memory");
const { runWakeUp, scheduleNextCheck } = require("../wake_up");

function writeWakeState(content = "没有时间戳的最后消息") {
  const userMessage = { role: "user", content };
  fs.writeFileSync(path.join(dataDirectory, "enhanced_messages.json"), JSON.stringify([
    { role: "system", content: "系统设定" },
    userMessage
  ]), "utf8");
  fs.writeFileSync(path.join(dataDirectory, "message_timestamps.json"), JSON.stringify({
    [makeFingerprint(userMessage)]: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  }), "utf8");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test.after(() => {
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("wake-up 使用最小 Requesty Chat Completions payload 并发送 Bark", async () => {
  writeWakeState();
  const originalFetch = global.fetch;
  const requests = [];
  try {
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (url === requestyUrl) {
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "想你了，在忙吗？" } }]
        });
      }
      if (url === "https://api.day.app/push") return jsonResponse(200, { code: 200 });
      if (url === `${gatewayBaseUrl}/internal/wake-event`) return jsonResponse(200, { success: true });
      throw new Error(`unexpected URL: ${url}`);
    };

    await runWakeUp();
  } finally {
    global.fetch = originalFetch;
  }

  const upstreamRequest = requests.find(request => request.url === requestyUrl);
  assert.ok(upstreamRequest);
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer wake-test-key");
  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.deepEqual(Object.keys(upstreamBody).sort(), ["messages", "model", "stream"]);
  assert.equal(upstreamBody.model, "anthropic/claude-sonnet-4-6");
  assert.equal(upstreamBody.stream, false);
  assert.equal(upstreamBody.messages.length, 2);
  assert.deepEqual(upstreamBody.messages.map(message => message.role), ["system", "user"]);
  for (const key of [
    "temperature", "top_p", "max_tokens", "max_completion_tokens",
    "frequency_penalty", "presence_penalty", "response_format", "tools", "tool_choice"
  ]) {
    assert.equal(Object.hasOwn(upstreamBody, key), false);
  }
  assert.equal(requests.filter(request => request.url === "https://api.day.app/push").length, 1);
  assert.equal(requests.filter(request => request.url === `${gatewayBaseUrl}/internal/wake-event`).length, 1);
  const barkPayload = JSON.parse(requests.find(request => request.url === "https://api.day.app/push").options.body);
  assert.equal(barkPayload.title, "阿言");
  assert.equal(barkPayload.body, "想你了，在忙吗？");
  assert.equal(barkPayload.icon, avatarUrl);
});

test("两行主动消息完整保留为正文，显示名称不取模型首行", async () => {
  writeWakeState("两行主动消息");
  const originalFetch = global.fetch;
  const requests = [];
  try {
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (url === requestyUrl) {
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "想你了\n早点休息呀" } }]
        });
      }
      if (url === "https://api.day.app/push") return jsonResponse(200, { code: 200 });
      if (url === `${gatewayBaseUrl}/internal/wake-event`) return jsonResponse(200, { success: true });
      throw new Error(`unexpected URL: ${url}`);
    };

    await runWakeUp();
  } finally {
    global.fetch = originalFetch;
  }

  const barkPayload = JSON.parse(requests.find(request => request.url === "https://api.day.app/push").options.body);
  assert.equal(barkPayload.title, "阿言");
  assert.match(barkPayload.body, /想你了/);
  assert.match(barkPayload.body, /早点休息呀/);
});

test("未设置 PUSH_DISPLAY_NAME 时默认使用阿言", async () => {
  writeWakeState("默认显示名称");
  const originalFetch = global.fetch;
  const originalDisplayName = process.env.PUSH_DISPLAY_NAME;
  const requests = [];
  try {
    delete process.env.PUSH_DISPLAY_NAME;
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (url === requestyUrl) {
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "默认名称测试" } }]
        });
      }
      if (url === "https://api.day.app/push") return jsonResponse(200, { code: 200 });
      if (url === `${gatewayBaseUrl}/internal/wake-event`) return jsonResponse(200, { success: true });
      throw new Error(`unexpected URL: ${url}`);
    };

    await runWakeUp();
  } finally {
    process.env.PUSH_DISPLAY_NAME = originalDisplayName;
    global.fetch = originalFetch;
  }

  const barkPayload = JSON.parse(requests.find(request => request.url === "https://api.day.app/push").options.body);
  assert.equal(barkPayload.title, "阿言");
});

test("[NO_ACTION] 与 [DIARY] 保持静默、写入日记并记录事件", async () => {
  writeWakeState("需要保持静默的消息");
  const originalFetch = global.fetch;
  const requests = [];
  try {
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (url === requestyUrl) {
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "[DIARY]测试日记[/DIARY]\n[NO_ACTION]" } }]
        });
      }
      if (url === `${gatewayBaseUrl}/internal/wake-event`) return jsonResponse(200, { success: true });
      throw new Error(`unexpected URL: ${url}`);
    };

    await runWakeUp();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requests.filter(request => request.url === "https://api.day.app/push").length, 0);
  assert.equal(requests.filter(request => request.url === `${gatewayBaseUrl}/internal/wake-event`).length, 1);
  const diaryDirectory = path.join(dataDirectory, "diary");
  const diaryFiles = fs.readdirSync(diaryDirectory);
  assert.equal(diaryFiles.length, 1);
  assert.match(fs.readFileSync(path.join(diaryDirectory, diaryFiles[0]), "utf8"), /测试日记/);
});

for (const status of [400, 500]) {
  test(`Requesty HTTP ${status} 被清晰处理且下一次唤醒检查仍会安排`, async () => {
    writeWakeState(`上游错误 ${status}`);
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    const originalConsoleError = console.error;
    const scheduled = [];
    const errors = [];
    try {
      global.fetch = async (url) => {
        if (url === `${gatewayBaseUrl}/internal/heartbeat`) return jsonResponse(200, { ok: true });
        if (url === requestyUrl) return jsonResponse(status, { error: { message: `Requesty ${status}` } });
        throw new Error(`unexpected URL: ${url}`);
      };
      global.setTimeout = (callback, delay) => {
        scheduled.push({ callback, delay });
        return { unref() {} };
      };
      console.error = (...args) => errors.push(args.map(String).join(" "));

      await scheduleNextCheck();
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      console.error = originalConsoleError;
    }

    assert.match(errors.join("\n"), new RegExp(`模型请求失败（HTTP ${status}）`));
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 60_000);
  });
}
