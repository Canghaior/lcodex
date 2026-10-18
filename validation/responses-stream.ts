import { isObject } from "./rpc.js";

export class ResponsesStream {
  constructor(private onEvent?: (event: Record<string, unknown>) => void) {}
  private buffer = "";
  private lastSequence = -1;
  private totalBytes = 0;
  private events = 0;
  private terminal: Record<string, unknown> | undefined;
  private terminalType: string | undefined;

  push(text: string): void {
    this.totalBytes += Buffer.byteLength(text);
    if (this.totalBytes > 2_000_000) throw new Error("SSE_SIZE_LIMIT");
    this.buffer += text;
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const lines = frame.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("SSE_INVALID_JSON"); }
      if (!isObject(event) || typeof event.type !== "string" || !Number.isSafeInteger(event.sequence_number) || Number(event.sequence_number) <= this.lastSequence) throw new Error("SSE_INVALID_SEQUENCE");
      if (this.terminal) throw new Error("SSE_AFTER_TERMINAL");
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      if (eventName && eventName !== event.type) throw new Error("SSE_TYPE_MISMATCH");
      this.lastSequence = Number(event.sequence_number);
      this.events++;
      this.onEvent?.(event);
      if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)) {
        if (!isObject(event.response)) throw new Error("SSE_INVALID_TERMINAL");
        if (event.response.status !== event.type.slice("response.".length)) throw new Error("SSE_STATUS_MISMATCH");
        this.terminal = event.response;
        this.terminalType = event.type;
      }
    }
    if (Buffer.byteLength(this.buffer) > 262_144) throw new Error("SSE_FRAME_LIMIT");
  }

  finish() {
    if (this.buffer.trim() || !this.terminal) throw new Error("SSE_MISSING_TERMINAL");
    return { response: this.terminal, terminalType: this.terminalType!, events: this.events };
  }
}
