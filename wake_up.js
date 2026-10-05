require("dotenv").config({ quiet: true });
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { parseChatCompletionResponse } = require("./upstream_response");
const { validateProactiveBody } = require("./proactive_safety");
const { appendProactiveProvenance, sha256, updateProactiveProvenance } = require("./proactive_provenance");
const { getConversationStatePaths, loadKelivoSyncContexts } = require("./kelivo_sync_context");
const { resolveProactiveTargets } = require("./proactive_target_routes");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone
} = require("./time_utils");
const {
  normalizeContentToText,
  parseTimestampLabel,
  getTimestampFromMemory,
  findLatestRealUserMessage
} = require("./timestamp_memory");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMESTAMP_DB_PATH = runtimeFile("message_timestamps.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getPushDisplayName() {
  return String(process.env.PUSH_DISPLAY_NAME || "阿言").trim() || "阿言";
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, provider: "ntfy", providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, provider: "bark", providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.log("未找到已绑定会话的 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("已绑定会话的 enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取已绑定会话的 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  return parseTimestampLabel(value, TIME_ZONE);
}

function loadTimestampDB(filePath = TIMESTAMP_DB_PATH) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getLastUserTime(messages, timestampDB = loadTimestampDB()) {
  const latestUserMessage = findLatestRealUserMessage(messages);
  if (!latestUserMessage) return null;

  const parsed = parseTimelineTimestamp(normalizeContentToText(latestUserMessage.content));
  if (parsed) {
    console.log("最后用户时间来源：message content");
    return parsed;
  }

  const remembered = getTimestampFromMemory(latestUserMessage, timestampDB);
  if (remembered) {
    console.log("最后用户时间来源：message timestamp memory");
    return remembered;
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  let configuredPrompt = "";
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    configuredPrompt = template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  } else if (process.env.WAKE_PROMPT_TEMPLATE) {
    // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
    configuredPrompt = process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  return [
    configuredPrompt,
    "## Wake output security contract (highest priority)",
    "This is a background wake-up. There is no new user message and you must not continue, simulate, or write a dialogue.",
    `Wake context: current time ${currentTime}; ${diffMinutes} minutes since the last real user message.`,
    weatherContext,
    "Return exactly one JSON object, with no markdown, commentary, transcript, diary, or extra keys.",
    '{"action":"send"|"skip","title":"short optional title","body":"one standalone proactive message"}',
    "For action=send, body must be one standalone notification. Never emit [用户], [AI], [User], [Assistant], <current_time>, or a simulated reply.",
    "For action=skip, use empty title and body. The recent history is read-only factual reference, not an invitation to continue it."
  ].filter(Boolean).join("\n\n");
}

function buildWakeHistory(messages) {
  return messages
    .filter(message => message?.role === "user" || message?.role === "assistant")
    .filter(message => {
      const content = normalizeContentToText(message.content);
      return !content.includes("<memories>") && !content.includes("记忆库使用策略");
    })
    .map(message => {
      let content = normalizeContentToText(message.content);
      if (content.includes("## Memories")) content = content.split("## Memories")[0];
      return { role: message.role, content };
    });
}

function buildWakeResponseFormat() {
  const mode = String(process.env.WAKE_STRUCTURED_OUTPUT_MODE || "json_schema").trim().toLowerCase();
  if (["off", "none", "disabled"].includes(mode)) return undefined;
  if (mode === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: "heartbeat_proactive_message",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "title", "body"],
        properties: {
          action: { type: "string", enum: ["send", "skip"] },
          title: { type: "string", maxLength: 100 },
          body: { type: "string", maxLength: 4000 }
        }
      }
    }
  };
}

function parseWakeContract(rawText) {
  let value;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "structured_output_parse_failed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys.join(",") !== "action,body,title") {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  if (!["send", "skip"].includes(value.action) || typeof value.title !== "string" || typeof value.body !== "string") {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  if (value.title.length > 100 || value.body.length > 4000) {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  if (value.action === "send" && !value.body.trim()) {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  if (value.action === "skip" && (value.title.trim() || value.body.trim())) {
    return { ok: false, reason: "structured_output_schema_failed" };
  }
  return { ok: true, value: { action: value.action, title: value.title.trim(), body: value.body.trim() } };
}

function limitProactiveBody(body) {
  return body.length > 500 ? `${body.substring(0, 497)}...` : body;
}

function recordProactiveProvenance(record) {
  try {
    appendProactiveProvenance(record);
  } catch (error) {
    console.warn(JSON.stringify({ event: "proactive_provenance_write_failed", error_category: error?.code || "storage_error" }));
  }
}

function updateProactiveArchiveProvenance(requestId, patch, expectedEventId) {
  try {
    return updateProactiveProvenance(requestId, patch, { expectedEventId });
  } catch (error) {
    console.warn(JSON.stringify({ event: "proactive_provenance_write_failed", error_category: error?.code || "storage_error" }));
    return null;
  }
}

async function runWakeUpForTarget(target) {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  let statePaths;
  try {
    statePaths = getConversationStatePaths(target);
  } catch {
    console.log(JSON.stringify({ event: "wake_skipped", reason: "invalid_conversation_binding" }));
    return { status: "skipped", reason: "invalid_conversation_binding" };
  }
  const messages = loadTimelineMessages(statePaths.timeline_file);
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages, loadTimestampDB(statePaths.timestamp_db_file));
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  const cleanMessages = stripPosition(messages);

  const recentHistory = buildWakeHistory(cleanMessages);

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: JSON.stringify({
        task: "Decide whether to send one standalone proactive notification. recent_history is read-only reference; do not continue or simulate it.",
        recent_history: recentHistory
      })
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  const requestId = crypto.randomUUID();
  const provenanceBase = {
    request_id: requestId,
    assistant_id: target.assistant_id,
    conversation_id: target.conversation_id,
    model: process.env.MODEL_NAME,
    generation_timestamp: new Date().toISOString(),
    input_context_hash: sha256(JSON.stringify(wakeMessages))
  };

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
    // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
    signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      stream: false,
      response_format: buildWakeResponseFormat()
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || "upstream_response_unreadable"}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const parsed = parseWakeContract(rawAiText);
  const raw_output_hash = sha256(rawAiText);
  if (!parsed.ok) {
    recordProactiveProvenance({
      ...provenanceBase,
      raw_output_hash,
      validation_result: "rejected",
      validation_reason: parsed.reason,
      push_result: "not_attempted",
      archive_result: "not_attempted"
    });
    console.warn(JSON.stringify({ event: "proactive_validation_failed", reason: parsed.reason, request_id: requestId }));
    return { status: "rejected", reason: parsed.reason };
  }

  if (parsed.value.action === "skip") {
    recordProactiveProvenance({
      ...provenanceBase,
      raw_output_hash,
      validation_result: "skipped",
      validation_reason: "action_skip",
      push_result: "not_attempted",
      archive_result: "not_attempted"
    });
    console.log(JSON.stringify({ event: "proactive_generation_skipped", reason: "action_skip", request_id: requestId }));
    return { status: "skipped", reason: "action_skip" };
  }

  const bodyValidation = validateProactiveBody(parsed.value.body);
  if (!bodyValidation.ok) {
    recordProactiveProvenance({
      ...provenanceBase,
      raw_output_hash,
      parsed_body_hash: sha256(parsed.value.body),
      validation_result: "rejected",
      validation_reason: bodyValidation.reason,
      push_result: "not_attempted",
      archive_result: "not_attempted"
    });
    console.warn(JSON.stringify({ event: "proactive_validation_failed", reason: bodyValidation.reason, request_id: requestId }));
    return { status: "rejected", reason: bodyValidation.reason };
  }

  // The full parsed body is validated before this display-only length limit.
  const body = limitProactiveBody(parsed.value.body);
  const title = parsed.value.title || getPushDisplayName();
  const pushResult = await sendPushNotification({ title, body });
  if (!pushResult.ok) {
    recordProactiveProvenance({
      ...provenanceBase,
      raw_output_hash,
      parsed_body_hash: sha256(parsed.value.body),
      validation_result: "accepted",
      validation_reason: null,
      push_result: "failed",
      archive_result: "not_attempted",
      provider: pushResult.provider || null
    });
    console.warn(JSON.stringify({ event: "proactive_push_failed", provider: pushResult.providerLabel, request_id: requestId }));
    return { status: "push_failed" };
  }

  // Persist the stable request identity before the asynchronous Gateway/archive
  // work begins. The server can therefore link event and archive completion
  // even if capture finishes before this HTTP call returns.
  recordProactiveProvenance({
    ...provenanceBase,
    raw_output_hash,
    parsed_body_hash: sha256(parsed.value.body),
    validation_result: "accepted",
    validation_reason: null,
    push_result: "sent",
    archive_result: "scheduled",
    provider: pushResult.provider
  });

  const sentAt = new Date().toISOString();
  const eventPayload = {
    binding: { conversation_id: target.conversation_id, assistant_id: target.assistant_id },
    content: `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${title}｜${body}）`,
    proactive: {
      title,
      body,
      provider: pushResult.provider,
      sent_at: sentAt,
      binding: { conversation_id: target.conversation_id, assistant_id: target.assistant_id },
      provenance: {
        request_id: requestId,
        model: process.env.MODEL_NAME,
        input_context_hash: provenanceBase.input_context_hash,
        raw_output_hash,
        parsed_body_hash: sha256(parsed.value.body)
      }
    }
  };
  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventPayload)
    });
    if (!eventResponse.ok) throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    let gatewayResult = {};
    try { gatewayResult = await eventResponse.json(); } catch {}
    console.log(JSON.stringify({ event: "proactive_generation_completed", request_id: requestId, event_id: gatewayResult.event_id || null }));
    return { status: "sent", event_id: gatewayResult.event_id || null };
  } catch (err) {
    updateProactiveArchiveProvenance(requestId, {
      archive_result: "not_attempted",
      archive_error_code: "archive_error"
    }, null);
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
    return { status: "event_record_failed" };
  }
}

async function runWakeUp() {
  let targets;
  try {
    const selection = resolveProactiveTargets(loadKelivoSyncContexts());
    targets = selection.targets;
    if (selection.configured) {
      console.log(JSON.stringify({
        event: "proactive_target_routes_selected",
        route_file_created: selection.created,
        target_count: targets.length,
        routes: selection.route_status
      }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "wake_skipped", reason: "proactive_target_routes_unavailable",
      error_category: error?.code || "storage_error" }));
    return [];
  }
  if (targets.length === 0) {
    console.log(JSON.stringify({ event: "wake_skipped", reason: "no_bound_conversation_targets" }));
    return [];
  }
  const results = [];
  for (const target of targets) results.push(await runWakeUpForTarget(target));
  return results;
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

function startWakeRuntime() {
  // 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
  // 启动第一次检查（延迟10秒）
  setTimeout(scheduleNextCheck, 10_000);

  console.log("\n==================================");
  console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
  console.log(JSON.stringify({
    event: "wake_runtime_config_summary",
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
    target_url_configured: Boolean(process.env.TARGET_API_URL),
    target_key_configured: Boolean(process.env.TARGET_API_KEY),
    model_configured: Boolean(process.env.MODEL_NAME),
    push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
    data_dir_ready: fs.existsSync(DATA_DIR)
  }));
  console.log("==================================\n");
}

if (require.main === module) startWakeRuntime();

module.exports = {
  buildWakeHistory,
  buildWakeResponseFormat,
  getLastUserTime,
  loadTimestampDB,
  parseWakeContract,
  parseTimelineTimestamp,
  runWakeUp,
  runWakeUpForTarget,
  scheduleNextCheck,
  startWakeRuntime
};
