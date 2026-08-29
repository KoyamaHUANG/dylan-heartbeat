const { normalizeContentToText } = require("../timestamp_memory");

function choiceText(choice = {}) {
  const delta = normalizeContentToText(choice?.delta?.content);
  if (delta) return delta;
  return normalizeContentToText(choice?.message?.content || choice?.text);
}

function choiceStructuredDelta(choice = {}) {
  const source = choice?.delta || choice?.message || {};
  const structured = {};
  for (const key of ["tool_calls", "function_call", "refusal", "audio", "annotations"]) {
    if (source[key] != null) structured[key] = source[key];
  }
  return Object.keys(structured).length > 0 ? structured : null;
}

class SseAssistantCollector {
  constructor() {
    this.decoder = new TextDecoder();
    this.pending = "";
    this.eventData = [];
    this.content = "";
    this.sawContent = false;
    this.sawStructured = false;
    this.sawDone = false;
    this.sawFinishReason = false;
    this.structuredDeltas = [];
  }

  get hasPayload() {
    return this.sawContent || this.sawStructured;
  }

  get complete() {
    return this.sawDone || this.sawFinishReason;
  }

  _dispatchEvent() {
    if (this.eventData.length === 0) return;
    const raw = this.eventData.join("\n");
    this.eventData = [];
    if (raw === "[DONE]") {
      this.sawDone = true;
      return;
    }
    try {
      const payload = JSON.parse(raw);
      const choice = payload?.choices?.[0] || {};
      if (
        Object.prototype.hasOwnProperty.call(choice?.delta || {}, "content") ||
        Object.prototype.hasOwnProperty.call(choice?.message || {}, "content")
      ) {
        this.sawContent = true;
      }
      const structured = choiceStructuredDelta(choice);
      if (structured) {
        this.sawStructured = true;
        this.structuredDeltas.push(structured);
      }
      if (choice?.finish_reason != null) this.sawFinishReason = true;
      this.content += choiceText(choice);
    } catch {
      // Upstream bytes are always forwarded. Malformed SSE cannot become
      // archive content or completion evidence.
    }
  }

  _consumeLine(line) {
    const value = String(line).replace(/\r$/, "");
    if (!value) {
      this._dispatchEvent();
      return;
    }
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let fieldValue = separator < 0 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "data") this.eventData.push(fieldValue);
    // event/id/retry are intentionally ignored: they do not describe the
    // assistant content or prove completion.
  }

  feed(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop();
    for (const line of lines) this._consumeLine(line);
  }

  finish() {
    this.pending += this.decoder.decode();
    if (this.pending) this._consumeLine(this.pending);
    this.pending = "";
    // EOF can end an event but is never completion proof by itself.
    this._dispatchEvent();
    return this.content;
  }

  archiveOutcome({ upstreamReadError = false, clientDisconnected = false } = {}) {
    const complete = !upstreamReadError && this.complete;
    return {
      content: this.content,
      has_payload: this.hasPayload,
      completion_status: complete ? "complete" : this.hasPayload ? "partial" : "failed",
      confirmed: complete,
      delivery_status: clientDisconnected ? "unconfirmed" : "unknown",
      termination_reason: upstreamReadError
        ? "upstream_read_error"
        : complete
          ? this.sawDone ? "sse_done" : "finish_reason"
          : "eof_without_completion_marker",
      structured_deltas: this.structuredDeltas
    };
  }
}

module.exports = { SseAssistantCollector, choiceStructuredDelta, choiceText };
