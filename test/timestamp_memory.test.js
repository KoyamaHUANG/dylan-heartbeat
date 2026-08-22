const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractTimestamp,
  loadTimestampDB: loadGatewayTimestampDB,
  makeFingerprint,
  makeFingerprintStripped,
  rememberContentTimestamps,
  rememberLatestUserReceiveTime
} = require("../server");
const { getLastUserTime, loadTimestampDB: loadWakeTimestampDB } = require("../wake_up");

test("正文完整日期时间继续优先使用原时间，并兼容 Kelivo 无空格格式", () => {
  const normal = { role: "user", content: "2026-08-22 10:30 早上好" };
  const compact = { role: "user", content: "2026-08-2210:31 早上好" };
  const db = {};

  assert.equal(extractTimestamp(normal.content).toISOString(), "2026-08-22T02:30:00.000Z");
  assert.equal(extractTimestamp(compact.content).toISOString(), "2026-08-22T02:31:00.000Z");
  assert.equal(rememberContentTimestamps([normal], db), true);
  assert.equal(getLastUserTime([normal], db).toISOString(), "2026-08-22T02:30:00.000Z");
});

test("Gateway 为没有正文时间戳的最新真实 user 消息记录服务器接收时间", () => {
  const message = { role: "user", content: "今天想聊聊天" };
  const db = {};
  const receivedAt = new Date("2026-08-22T03:04:05.000Z");

  assert.equal(rememberLatestUserReceiveTime([message], db, receivedAt), true);
  assert.equal(db[makeFingerprint(message)], receivedAt.toISOString());
  assert.equal(db[makeFingerprintStripped(message)], receivedAt.toISOString());
});

test("同一条无时间戳用户消息重复经过 Gateway 不会刷新接收时间", () => {
  const message = { role: "user", content: "同一条重试消息" };
  const db = {};
  const first = new Date("2026-08-22T03:04:05.000Z");

  assert.equal(rememberLatestUserReceiveTime([message], db, first), true);
  assert.equal(rememberLatestUserReceiveTime([message], db, new Date("2026-08-22T04:05:06.000Z")), false);
  assert.equal(db[makeFingerprint(message)], first.toISOString());
});

test("多条无时间戳历史 user 消息只为本次最新真实 user 消息补接收时间", () => {
  const oldOne = { role: "user", content: "旧消息一" };
  const oldTwo = { role: "user", content: "旧消息二" };
  const pseudoSystem = { role: "user", content: "<system>不是用户消息</system>" };
  const latest = { role: "user", content: "本次新消息" };
  const db = {};
  const receivedAt = new Date("2026-08-22T03:04:05.000Z");

  assert.equal(rememberLatestUserReceiveTime([oldOne, oldTwo, pseudoSystem, latest], db, receivedAt), true);
  assert.equal(db[makeFingerprint(latest)], receivedAt.toISOString());
  assert.equal(db[makeFingerprint(oldOne)], undefined);
  assert.equal(db[makeFingerprint(oldTwo)], undefined);
  assert.equal(db[makeFingerprint(pseudoSystem)], undefined);
});

test("wake-up 可从 message timestamp memory 找回无正文时间戳的最后用户时间", () => {
  const message = { role: "user", content: "没有日期时间的最后消息" };
  const db = { [makeFingerprint(message)]: "2026-08-22T03:04:05.000Z" };

  assert.equal(getLastUserTime([message], db).toISOString(), "2026-08-22T03:04:05.000Z");
});

test("wake-up 兼容既有 stripped fingerprint 时间戳记录", () => {
  const message = { role: "user", content: "没有日期时间的旧记录" };
  const db = { [makeFingerprintStripped(message)]: "2026-08-21T03:04:05.000Z" };

  assert.equal(getLastUserTime([message], db).toISOString(), "2026-08-21T03:04:05.000Z");
});

test("缺失或损坏的 timestamp DB 安全降级为空记录", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-timestamps-"));
  const missing = path.join(directory, "missing.json");
  const corrupt = path.join(directory, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json", "utf8");

  try {
    assert.deepEqual(loadGatewayTimestampDB(missing), {});
    assert.deepEqual(loadWakeTimestampDB(missing), {});
    assert.deepEqual(loadGatewayTimestampDB(corrupt), {});
    assert.deepEqual(loadWakeTimestampDB(corrupt), {});
    assert.equal(getLastUserTime([{ role: "user", content: "无记录" }], {}), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
