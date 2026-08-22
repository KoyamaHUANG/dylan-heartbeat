const test = require("node:test");
const assert = require("node:assert/strict");
const { isSpecialEventContent } = require("../special_events");

test("accepts real timestamped wake events", () => {
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 自动唤醒：本次未发送推送｜原因：不打扰）"), true);
  assert.equal(isSpecialEventContent("（2026/8/10 20:10:03 刚刚给用户发了Bark推送：标题｜正文）"), true);
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 刚刚给宝宝发了 Bark：测试）"), true);
  assert.equal(isSpecialEventContent("（22:20 刚刚给用户发了 Bark 推送：旧记录）"), true);
});

test("does not turn ordinary replies mentioning event words into events", () => {
  assert.equal(isSpecialEventContent("我刚刚给用户发了推送，不过这只是回答里的说明。"), false);
  assert.equal(isSpecialEventContent("2026-08-10 20:10 我觉得‘自动唤醒：本次未发送推送’这句话很奇怪。"), false);
});
