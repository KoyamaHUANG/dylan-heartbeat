const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { ArchiveStore } = require("../archive/archive_store");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-archive-integration-"));
const upstreamUrl = "https://archive-integration.invalid/v1/chat/completions";
const gatewayKey = "gateway-integration-key";
const archiveKey = "archive-integration-key";

process.env.DATA_DIR = dataDirectory;
process.env.RAILWAY_ENVIRONMENT = "test";
process.env.ALLOW_PUBLIC_API = "true";
process.env.GATEWAY_API_KEY = gatewayKey;
process.env.TARGET_API_URL = upstreamUrl;
process.env.TARGET_API_KEY = "upstream-integration-key";
process.env.ARCHIVE_ENABLED = "true";
process.env.ARCHIVE_DATABASE_URL = "postgres://archive-test.invalid/archive";
process.env.ARCHIVE_API_KEY = archiveKey;
process.env.TIME_ZONE = "Asia/Shanghai";

const { app, rawChatArchive } = require("../server");

const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, "..", "migrations", "001_initial.sql"), "utf8"));
db.public.none(fs.readFileSync(path.join(__dirname, "..", "migrations", "002_kelivo_archive_identity.sql"), "utf8"));
const { Pool } = db.adapters.createPg();
const archiveStore = new ArchiveStore({ pool: new Pool() });
archiveStore.migrated = true;
rawChatArchive.store = archiveStore;

const originalFetch = global.fetch;
let upstreamOverride = null;
global.fetch = async (url, options = {}) => {
  if (upstreamOverride) return upstreamOverride(url, options);
  assert.equal(String(url), upstreamUrl);
  const request = JSON.parse(options.body);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "_kelivo_archive"), false);
  for (const key of Object.keys(options.headers || {})) {
    assert.equal(key.toLowerCase().startsWith("x-kelivo-archive-"), false);
    assert.notEqual(key.toLowerCase(), "x-kelivo-request-id");
    assert.notEqual(key.toLowerCase(), "x-kelivo-user-message-id");
    assert.notEqual(key.toLowerCase(), "x-kelivo-parent-request-id");
  }
  if (request.stream) {
    return new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"流式\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"回复\"}}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "正常回复" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

function publicHeaders(extra = {}) {
  return { authorization: `Bearer ${gatewayKey}`, ...extra };
}

let identitySerial = 0;

async function chat(messages, { stream = false, requestId, userMessageId, userMessageIndex } = {}) {
  const index = userMessageIndex ?? messages.map(message => message.role).lastIndexOf("user");
  const user = messages[index];
  const serial = ++identitySerial;
  const resolvedRequestId = requestId || `request-${serial}`;
  const resolvedUserMessageId = userMessageId || `message-${serial}`;
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    remoteAddress: "10.0.0.8",
    headers: publicHeaders({
      "x-kelivo-conversation-id": "conversation-A",
      "x-kelivo-assistant-id": "ayan",
      "x-kelivo-archive-protocol": "1",
      "x-kelivo-request-id": resolvedRequestId,
      "x-kelivo-user-message-id": resolvedUserMessageId
    }),
    payload: {
      model: "test-model", stream, messages,
      _kelivo_archive: {
        version: 1,
        kind: "user_send",
        conversation_id: "conversation-A",
        assistant_id: "ayan",
        request_id: resolvedRequestId,
        user_message_id: resolvedUserMessageId,
        user_message_index: index,
        user_message_time: "2026-08-30T15:08:03.000Z",
        user_archive_content: {
          format: "kelivo_chat_message_parts_v1",
          parts: [{ type: "text", text: user?.content || "" }]
        }
      }
    }
  });
}

async function continuation(requestId, messages) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    remoteAddress: "10.0.0.8",
    headers: publicHeaders({
      "x-kelivo-conversation-id": "conversation-A",
      "x-kelivo-assistant-id": "ayan",
      "x-kelivo-archive-protocol": "1",
      "x-kelivo-request-id": requestId,
      "x-kelivo-parent-request-id": requestId
    }),
    payload: {
      model: "test-model",
      messages,
      _kelivo_archive: {
        version: 1,
        kind: "continuation",
        conversation_id: "conversation-A",
        assistant_id: "ayan",
        request_id: requestId,
        parent_request_id: requestId
      }
    }
  });
}

test.after(async () => {
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("gateway chat remains unchanged while non-stream and stream assistants archive in the background", async () => {
  const nonStream = await chat([{ role: "user", content: "第一句" }]);
  assert.equal(nonStream.statusCode, 200);
  assert.equal(JSON.parse(nonStream.body).choices[0].message.content, "正常回复");
  await rawChatArchive.flush();

  const stream = await chat([
    { role: "user", content: "第一句" },
    { role: "assistant", content: "正常回复" },
    { role: "user", content: "第二句" }
  ], { stream: true });
  assert.equal(stream.statusCode, 200);
  assert.match(stream.body, /data:/);
  await rawChatArchive.flush();

  const archive = await app.inject({
    method: "GET",
    url: "/v1/archive/messages?conversation_id=conversation-A",
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${archiveKey}` }
  });
  assert.equal(archive.statusCode, 200);
  const payload = JSON.parse(archive.body);
  assert.deepEqual(payload.messages.map(row => row.content), ["第一句", "正常回复", "第二句", "流式回复"]);
  assert.deepEqual(payload.messages.map(row => row.sequence), [1, 2, 3, 4]);
});

test("archive routes reject absent and gateway-only keys, paginate stably, and return stats", async () => {
  const noKey = await app.inject({ method: "GET", url: "/v1/archive/messages?conversation_id=conversation-A", remoteAddress: "10.0.0.8" });
  assert.equal(noKey.statusCode, 401);
  const gatewayOnly = await app.inject({
    method: "GET",
    url: "/v1/archive/messages?conversation_id=conversation-A",
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${gatewayKey}` }
  });
  assert.equal(gatewayOnly.statusCode, 401);
  const firstPage = await app.inject({
    method: "GET",
    url: "/v1/archive/messages?conversation_id=conversation-A&limit=2",
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${archiveKey}` }
  });
  assert.equal(firstPage.statusCode, 200);
  const first = JSON.parse(firstPage.body);
  assert.equal(first.messages.length, 2);
  assert.ok(first.next_cursor);
  const secondPage = await app.inject({
    method: "GET",
    url: `/v1/archive/messages?conversation_id=conversation-A&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${archiveKey}` }
  });
  assert.equal(secondPage.statusCode, 200);
  const second = JSON.parse(secondPage.body);
  assert.deepEqual([...first.messages, ...second.messages].map(row => row.sequence), [1, 2, 3, 4]);
  const stats = await app.inject({
    method: "GET",
    url: "/v1/archive/stats?conversation_id=conversation-A",
    remoteAddress: "10.0.0.8",
    headers: { authorization: `Bearer ${archiveKey}` }
  });
  assert.equal(stats.statusCode, 200);
  assert.deepEqual(JSON.parse(stats.body).total, 4);
});

test("Gateway archives EOF-without-DONE and upstream reader errors as explicit partial assistants", async () => {
  try {
    upstreamOverride = async () => new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"EOF 半截\"}}]}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
    const eof = await chat([{ role: "user", content: "EOF 请求" }], { stream: true });
    assert.equal(eof.statusCode, 200);
    await rawChatArchive.flush();

    let emittedReaderChunk = false;
    upstreamOverride = async () => new Response(new ReadableStream({
      pull(controller) {
        if (!emittedReaderChunk) {
          emittedReaderChunk = true;
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"错误半截\"}}]}\n\n"));
          return;
        }
        controller.error(Object.assign(new Error("read failed"), { code: "ECONNRESET" }));
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const errored = await chat([{ role: "user", content: "错误请求" }], { stream: true });
    assert.equal(errored.statusCode, 200);
    await rawChatArchive.flush();

    const partials = await rawChatArchive.store.pool.query(
      "SELECT content_text, completion_status, confirmed, metadata_json FROM archive_messages WHERE completion_status = 'partial' ORDER BY sequence"
    );
    assert.deepEqual(partials.rows.map(row => [row.content_text, row.completion_status, row.confirmed]), [
      ["EOF 半截", "partial", false],
      ["错误半截", "partial", false]
    ]);
    assert.match(JSON.stringify(partials.rows[1].metadata_json), /upstream_read_error/);
  } finally {
    upstreamOverride = null;
  }
});

test("Gateway stores tool-call-only assistants as a non-canonical phase and preserves the final slot", async () => {
  try {
    upstreamOverride = async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_archive", type: "function", function: { name: "lookup", arguments: "{}" } }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
    const response = await chat([{ role: "user", content: "结构化请求" }], { requestId: "tool-root", userMessageId: "tool-user" });
    assert.equal(response.statusCode, 200);
    await rawChatArchive.flush();
    upstreamOverride = null;
    const followUp = await continuation("tool-root", [
      { role: "user", content: "结构化请求" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_archive", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_archive", content: "result" }
    ]);
    assert.equal(followUp.statusCode, 200);
    await rawChatArchive.flush();
    const phase = (await rawChatArchive.store.pool.query(
      "SELECT content_text, canonical, metadata_json FROM archive_messages WHERE source = 'gateway_assistant_tool_phase' ORDER BY sequence DESC LIMIT 1"
    )).rows[0];
    assert.equal(phase.content_text, "");
    assert.equal(phase.canonical, false);
    assert.match(JSON.stringify(phase.metadata_json), /call_archive/);
    const canonical = (await rawChatArchive.store.pool.query(
      "SELECT content_text FROM archive_messages WHERE source = 'gateway_assistant' ORDER BY sequence DESC LIMIT 1"
    )).rows[0];
    assert.equal(canonical.content_text, "正常回复");
  } finally {
    upstreamOverride = null;
  }
});

test("archive-disabled streaming EOF without assistant data remains a normal Gateway response", async () => {
  const enabled = rawChatArchive.enabled;
  try {
    rawChatArchive.enabled = false;
    upstreamOverride = async () => new Response("", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
    const response = await chat([{ role: "user", content: "禁用态空流" }], { stream: true });
    assert.equal(response.statusCode, 200);
  } finally {
    rawChatArchive.enabled = enabled;
    upstreamOverride = null;
  }
});
