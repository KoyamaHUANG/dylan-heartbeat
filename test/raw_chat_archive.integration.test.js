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
const { Pool } = db.adapters.createPg();
const archiveStore = new ArchiveStore({ pool: new Pool() });
archiveStore.migrated = true;
rawChatArchive.store = archiveStore;

const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  assert.equal(String(url), upstreamUrl);
  const request = JSON.parse(options.body);
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

async function chat(messages, { stream = false } = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    remoteAddress: "10.0.0.8",
    headers: publicHeaders({
      "x-kelivo-conversation-id": "conversation-A",
      "x-kelivo-assistant-id": "ayan"
    }),
    payload: { model: "test-model", stream, messages }
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
