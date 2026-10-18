import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { isolatedEnvironment } from "./isolated-env.js";
import { JsonLineRpc } from "./rpc.js";

function connection(timeout = 1_000, maxBytes = 1_048_576) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  output.on("data", (data: Buffer) => sent.push(JSON.parse(data.toString())));
  const rpc = new JsonLineRpc(input, output, timeout, maxBytes);
  return { input, sent, rpc };
}

test("fragmented UTF-8 and out-of-order responses retain request association", async () => {
  const { input, sent, rpc } = connection();
  const first = rpc.request("first", {});
  const second = rpc.request("second", {});
  assert.deepEqual(sent.map((item) => item.id), [1, 2]);
  const frame = Buffer.from('{"method":"progress","params":{}}\n{"id":2,"result":"中文"}\n{"id":1,"result":42}\n');
  for (const byte of frame) input.write(Buffer.from([byte]));
  assert.equal(await first, 42);
  assert.equal(await second, "中文");
  assert.equal(rpc.notifications, 1);
  input.end();
});

test("remote errors do not echo sensitive payloads", async () => {
  const { input, rpc } = connection();
  const response = rpc.request("fail", {});
  input.write('{"id":1,"error":{"code":-1,"message":"synthetic private content"}}\n');
  await assert.rejects(response, { message: "RPC_REMOTE_ERROR_-1" });
  input.end();
});

test("server requests are denied, never executed", () => {
  const { input, sent, rpc } = connection();
  input.write('{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{}}\n');
  assert.equal(rpc.deniedServerRequests, 1);
  assert.equal(sent[0]?.id, "approval-1");
  assert.deepEqual(sent[0]?.error, { code: -32601, message: "Offline probe denies server requests" });
  input.end();
});

for (const [label, payload] of [
  ["invalid JSON", "invalid\n"],
  ["unknown ID", '{"id":99,"result":true}\n'],
  ["missing result", '{"id":1}\n'],
  ["ambiguous response", '{"id":1,"result":true,"error":{"code":-1}}\n'],
  ["invalid error", '{"id":1,"error":"invalid"}\n'],
]) {
  test(`${label} fails pending requests`, async () => {
    const { input, rpc } = connection();
    const response = rpc.request("pending", {});
    input.write(payload);
    await assert.rejects(response, { message: "RPC_INVALID_FRAME" });
    await assert.rejects(rpc.request("later", {}), { message: "RPC_INVALID_FRAME" });
    input.end();
  });
}

test("oversized frame fails without retaining its contents", async () => {
  const { input, rpc } = connection(1_000, 20);
  const response = rpc.request("pending", {});
  input.write("x".repeat(21));
  await assert.rejects(response, { message: "RPC_FRAME_TOO_LARGE" });
  input.end();
});

test("timeout closes the connection without retrying", async () => {
  const { input, sent, rpc } = connection(30);
  await assert.rejects(rpc.request("pending", {}), { message: "RPC_TIMEOUT" });
  await assert.rejects(rpc.request("later", {}), { message: "RPC_TIMEOUT" });
  assert.equal(sent.length, 1);
  input.end();
});

test("disconnect rejects unfinished work", async () => {
  const { input, rpc } = connection();
  const response = rpc.request("pending", {});
  input.end();
  await assert.rejects(response, { message: "RPC_DISCONNECTED" });
});

test("isolated child environment excludes credentials and redirects profile", () => {
  const env = isolatedEnvironment("D:/temporary-probe", {
    Path: "system-path", SystemRoot: "C:/Windows", DEEPSEEK_API_KEY: "synthetic",
    OPENAI_API_KEY: "synthetic", NODE_OPTIONS: "unsafe", HTTP_PROXY: "credentialed-proxy",
    USERPROFILE: "private-profile", CODEX_HOME: "existing-settings",
  });
  assert.equal(env.PATH, "system-path");
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.notEqual(env.USERPROFILE, "private-profile");
  assert.notEqual(env.CODEX_HOME, "existing-settings");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:9");
});
