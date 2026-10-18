import type { Readable, Writable } from "node:stream";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validation transport only. No retries, model calls or tool execution here.
export class JsonLineRpc {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private failure: Error | undefined;
  notifications = 0;
  deniedServerRequests = 0;

  constructor(
    input: Readable,
    private output: Writable,
    private timeoutMs = 5_000,
    private maxFrameBytes = 1_048_576,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.consume(chunk));
    input.on("end", () => this.abort(new Error("RPC_DISCONNECTED")));
    input.on("error", () => this.abort(new Error("RPC_INPUT_ERROR")));
    output.on("error", () => this.abort(new Error("RPC_OUTPUT_ERROR")));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new Error("RPC_TIMEOUT")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure;
    this.send({ method, params });
  }

  abort(error: Error): void {
    this.failure ??= error;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  private send(message: unknown): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.abort(new Error("RPC_OUTPUT_ERROR"));
      });
    } catch {
      this.abort(new Error("RPC_OUTPUT_ERROR"));
    }
  }

  private consume(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    while (!this.failure) {
      const newline = this.buffer.indexOf("\n");
      const frame = newline < 0 ? this.buffer : this.buffer.slice(0, newline);
      if (Buffer.byteLength(frame) > this.maxFrameBytes) {
        this.abort(new Error("RPC_FRAME_TOO_LARGE"));
        return;
      }
      if (newline < 0) return;
      this.buffer = this.buffer.slice(newline + 1);
      if (!frame.trim()) continue;
      try {
        this.receive(JSON.parse(frame));
      } catch {
        // Never include raw protocol payloads in errors or diagnostic output.
        this.abort(new Error("RPC_INVALID_FRAME"));
      }
    }
  }

  private receive(message: unknown): void {
    if (!isObject(message)) throw new Error();
    if (typeof message.method === "string") {
      if ("result" in message || "error" in message) throw new Error();
      if ("id" in message) {
        if (typeof message.id !== "number" && typeof message.id !== "string") throw new Error();
        // The offline probe never grants approvals or performs server-requested actions.
        this.deniedServerRequests++;
        this.send({ id: message.id, error: { code: -32601, message: "Offline probe denies server requests" } });
      } else {
        this.notifications++;
      }
      return;
    }
    if (typeof message.id !== "number") throw new Error();
    const pending = this.pending.get(message.id);
    if (!pending || ("result" in message) === ("error" in message)) throw new Error();
    if ("error" in message && (!isObject(message.error) || typeof message.error.code !== "number")) throw new Error();
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (isObject(message.error)) {
      pending.reject(new Error(`RPC_REMOTE_ERROR_${message.error.code}`));
    } else {
      pending.resolve(message.result);
    }
  }
}
