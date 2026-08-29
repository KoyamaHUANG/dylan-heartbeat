const { normalizeContentToText } = require("../timestamp_memory");

function choiceText(choice = {}) {
  const delta = normalizeContentToText(choice?.delta?.content);
  if (delta) return delta;
  return normalizeContentToText(choice?.message?.content || choice?.text);
}

class SseAssistantCollector {
  constructor() {
    this.decoder = new TextDecoder();
    this.pending = "";
    this.content = "";
    this.sawContent = false;
  }

  _consumeLine(line) {
    const match = String(line).match(/^data:\s?(.*)$/i);
    if (!match) return;
    const raw = match[1].trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const payload = JSON.parse(raw);
      const choice = payload?.choices?.[0] || {};
      if (Object.prototype.hasOwnProperty.call(choice?.delta || {}, "content") || Object.prototype.hasOwnProperty.call(choice?.message || {}, "content")) {
        this.sawContent = true;
      }
      this.content += choiceText(choice);
    } catch {
      // Upstream bytes still pass through unchanged; malformed data is not archive content.
    }
  }

  feed(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop();
    for (const line of lines) this._consumeLine(line);
  }

  finish() {
    this.pending += this.decoder.decode();
    if (this.pending) this._consumeLine(this.pending);
    this.pending = "";
    return this.content;
  }
}

module.exports = { SseAssistantCollector, choiceText };
