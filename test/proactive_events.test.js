const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendProactiveEvent,
  listProactiveEvents,
  loadProactiveStore
} = require("../proactive_events");

function createStorePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-proactive-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "proactive_events.json");
}

function eventInput(overrides = {}) {
  return {
    conversation_id: "conversation-A",
    assistant_id: "ayan",
    title: "阿言",
    body: "主动消息测试",
    source: "wake",
    push_provider: "bark",
    ...overrides
  };
}

test("proactive store 自动初始化并以 UUID 和 seq=1 写入 DATA_DIR 文件", t => {
  const filePath = createStorePath(t);
  assert.deepEqual(loadProactiveStore(filePath), { version: 1, next_seq: 1, events: [] });

  const event = appendProactiveEvent(eventInput(), { filePath });
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.match(event.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(event.seq, 1);
  assert.equal(event.role, "assistant");
  assert.equal(stored.version, 1);
  assert.equal(stored.next_seq, 2);
  assert.equal(stored.events.length, 1);
});

test("seq 单调递增且重新 load 后继续递增", t => {
  const filePath = createStorePath(t);
  const seqs = [
    appendProactiveEvent(eventInput({ body: "一" }), { filePath }).seq,
    appendProactiveEvent(eventInput({ body: "二" }), { filePath }).seq,
    appendProactiveEvent(eventInput({ body: "三" }), { filePath }).seq
  ];
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(loadProactiveStore(filePath).next_seq, 4);
  assert.equal(appendProactiveEvent(eventInput({ body: "四" }), { filePath }).seq, 4);
});

test("conversation 隔离、cursor、分页和多客户端重复读取均不改变事件", t => {
  const filePath = createStorePath(t);
  for (const body of ["A1", "A2", "A3"]) appendProactiveEvent(eventInput({ body }), { filePath });
  for (const body of ["B1", "B2"]) {
    appendProactiveEvent(eventInput({ conversation_id: "conversation-B", assistant_id: null, body }), { filePath });
  }

  const clientOne = listProactiveEvents({ conversation_id: "conversation-A", after_seq: 0 }, { filePath });
  const clientTwo = listProactiveEvents({ conversation_id: "conversation-A", after_seq: 0 }, { filePath });
  assert.deepEqual(clientOne.data.map(event => event.seq), [1, 2, 3]);
  assert.deepEqual(clientTwo.data.map(event => event.event_id), clientOne.data.map(event => event.event_id));
  assert.equal(listProactiveEvents({ conversation_id: "conversation-B" }, { filePath }).data.length, 2);
  assert.deepEqual(listProactiveEvents({ conversation_id: "conversation-A", assistant_id: "other" }, { filePath }).data, []);

  const afterOne = listProactiveEvents({ conversation_id: "conversation-A", after_seq: 1 }, { filePath });
  assert.deepEqual(afterOne.data.map(event => event.seq), [2, 3]);
  assert.deepEqual(
    listProactiveEvents({ conversation_id: "conversation-A", after_seq: 1 }, { filePath }).data.map(event => event.event_id),
    afterOne.data.map(event => event.event_id)
  );

  const firstPage = listProactiveEvents({ conversation_id: "conversation-A", limit: 2 }, { filePath });
  assert.equal(firstPage.data.length, 2);
  assert.equal(firstPage.next_after_seq, 2);
  assert.equal(firstPage.has_more, true);
  assert.deepEqual(
    listProactiveEvents({ conversation_id: "conversation-A", after_seq: firstPage.next_after_seq, limit: 2 }, { filePath }).data.map(event => event.seq),
    [3]
  );

  const beforeReads = loadProactiveStore(filePath).events.length;
  for (let index = 0; index < 10; index += 1) listProactiveEvents({ conversation_id: "conversation-A" }, { filePath });
  assert.equal(loadProactiveStore(filePath).events.length, beforeReads);
});

test("retention 只裁剪最旧事件，不重新编号 seq", t => {
  const filePath = createStorePath(t);
  for (let index = 1; index <= 5; index += 1) {
    appendProactiveEvent(eventInput({ body: `消息${index}` }), { filePath, maxCount: 3 });
  }
  const store = loadProactiveStore(filePath);
  assert.equal(store.next_seq, 6);
  assert.deepEqual(store.events.map(event => event.seq), [3, 4, 5]);
  const listed = listProactiveEvents({ conversation_id: "conversation-A", after_seq: 0 }, { filePath });
  assert.equal(listed.oldest_seq, 3);
  assert.equal(listed.latest_seq, 5);
});

test("损坏 store 与非法 API 输入安全降级或返回验证错误", t => {
  const filePath = createStorePath(t);
  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.deepEqual(loadProactiveStore(filePath), { version: 1, next_seq: 1, events: [] });
  assert.throws(() => listProactiveEvents({ conversation_id: "", after_seq: 0 }, { filePath }));
  assert.throws(() => listProactiveEvents({ conversation_id: "conversation-A", after_seq: "-1" }, { filePath }));
  assert.throws(() => listProactiveEvents({ conversation_id: "conversation-A", limit: 101 }, { filePath }));
  assert.throws(() => appendProactiveEvent(eventInput({ body: "" }), { filePath }));
  assert.throws(() => appendProactiveEvent(eventInput({ conversation_id: 123 }), { filePath }));
});
