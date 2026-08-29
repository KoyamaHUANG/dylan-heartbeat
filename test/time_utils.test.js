const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDateTimeInTimeZone,
  getHourInTimeZone,
  zonedWallTimeToDate
} = require("../time_utils");

test("parses Kelivo Beijing wall time independently of the server timezone", () => {
  const parsed = zonedWallTimeToDate(
    { year: "2026", month: "07", day: "30", hour: "20", minute: "15" },
    "Asia/Shanghai"
  );
  assert.equal(parsed.toISOString(), "2026-07-30T12:15:00.000Z");
});

test("formats wake-up time and day/night hour in the configured timezone", () => {
  const date = new Date("2026-07-30T02:15:00.000Z");
  assert.equal(formatDateTimeInTimeZone(date, "Asia/Shanghai"), "2026-07-30 10:15");
  assert.equal(getHourInTimeZone(date, "Asia/Shanghai"), 10);
});

test("rejects ambiguous and nonexistent IANA wall times instead of choosing an offset", () => {
  assert.equal(
    zonedWallTimeToDate({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York"),
    null
  );
  assert.equal(
    zonedWallTimeToDate({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"),
    null
  );
});
