// 特殊事件须从带时间的括号前缀和明确事件文案一起识别；旧 Volume 中只有 HH:mm
// 的记录也要保留，普通回答即使提到推送或 Bark 仍不会被当作事件反复注入。
const SPECIAL_EVENT_PREFIX = /^\s*[（(]\s*(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}(?::\d{2})?|\d{1,2}[:：]\d{2})\s+(?:自动唤醒：本次未发送(?:\s*(?:Bark|推送))?|刚刚发送了推送|刚刚给(?:宝宝|用户)发了\s*(?:Bark|ntfy)?\s*推送|刚刚给(?:宝宝|用户)发了\s*Bark)(?:[：:｜|）)]|\s|$)/i;

function isSpecialEventContent(content) {
  return SPECIAL_EVENT_PREFIX.test(String(content || ""));
}

module.exports = { isSpecialEventContent, SPECIAL_EVENT_PREFIX };
