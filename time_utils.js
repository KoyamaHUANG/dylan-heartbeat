const { Temporal } = require("@js-temporal/polyfill");

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function resolveTimeZone(raw = process.env.TIME_ZONE, fallback = DEFAULT_TIME_ZONE) {
  const zone = String(raw || "").trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    console.warn(`TIME_ZONE=${zone} 无效，已回退到 ${fallback}`);
    return fallback;
  }
}

function getDatePartsInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second || "00"
  };
}

function formatDateTimeInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function getHourInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  return Number(getDatePartsInTimeZone(date, timeZone).hour);
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second || "00")
  );
  return asUTC - date.getTime();
}

function zonedWallTimeToDate({ year, month, day, hour, minute }, timeZone = resolveTimeZone()) {
  try {
    // Wall-clock timestamps must identify one real instant.  Do not silently
    // choose an offset for a skipped or repeated local time.
    const zoned = Temporal.ZonedDateTime.from({
      timeZone,
      calendar: "iso8601",
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0
    }, { disambiguation: "reject" });
    return new Date(Number(zoned.epochMilliseconds));
  } catch {
    return null;
  }
}

function localDateRangeToUtc(dateText, timeZone = resolveTimeZone()) {
  const match = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  try {
    const localDate = Temporal.PlainDate.from(dateText);
    const nextLocalDate = localDate.add({ days: 1 });
    // [start, nextStart) is derived from two independently resolved local
    // midnights, so DST days can be 23, 24, or 25 hours. A skipped/repeated
    // midnight is rejected instead of being mapped to a neighbouring date.
    const start = zonedWallTimeToDate({
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hour: 0,
      minute: 0
    }, timeZone);
    const end = zonedWallTimeToDate({
      year: nextLocalDate.year,
      month: nextLocalDate.month,
      day: nextLocalDate.day,
      hour: 0,
      minute: 0
    }, timeZone);
    if (!start || !end || end <= start) return null;
    return { start, end };
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_TIME_ZONE,
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  localDateRangeToUtc,
  resolveTimeZone,
  zonedWallTimeToDate
};
