export async function readKey(): Promise<string> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (!process.stdin.isTTY) throw new Error("PROBE_KEY_REQUIRED");
  process.stdout.write("Enter DeepSeek key (hidden input; memory only):\n");
  return new Promise((resolve, reject) => {
    let key = "";
    const done = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (error) reject(error); else resolve(key);
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003") { done(new Error("PROBE_KEY_CANCELLED")); return; }
        if (char === "\r" || char === "\n") { done(); return; }
        if (char === "\u007f" || char === "\b") key = key.slice(0, -1);
        else key += char;
        if (key.length > 256) { done(new Error("PROBE_KEY_INVALID")); return; }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
