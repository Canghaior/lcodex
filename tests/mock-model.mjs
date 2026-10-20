// Test-only model transport. The real app-server, MXC, edits and UI remain in use.
// Imported into the application's main process only by this test runner.
const counts = new Map();
const quote = text => "'" + text.replaceAll("'", "''") + "'";
globalThis.fetch = async (url, init) => {
  if (url !== "https://api.deepseek.com/responses") throw new Error("TEST_UNEXPECTED_NETWORK");
  const body = JSON.parse(init.body);
  if (body.model !== "deepseek-v4-pro" || body.reasoning?.effort !== "high" || body.max_output_tokens !== 8192) throw new Error("TEST_MODEL_CONFIGURATION_MISMATCH");
  const tool = body.tools.find(tool => tool.name === "exec_command");
  const connecting = !tool;
  const cwd = tool?.parameters.properties.workdir.enum[0] ?? "connection", shell = tool?.parameters.properties.shell.enum[0] ?? "";
  const n = (counts.get(cwd) ?? 0) + 1; counts.set(cwd, n);
  const callSuffix = crypto.randomUUID();
  const writeMode = body.tools.some(tool => tool.name === "apply_patch");
  const readBeforeChecks = writeMode && globalThis.lcodexTestReadBeforeChecks === true;
  const step = n - (readBeforeChecks ? 1 : 0);
  const stopping = JSON.stringify(body.input).includes("STOP_TREE");
  const continuing = JSON.stringify(body.input).includes("CONTINUE_AFTER_RESTART");
  if (continuing && n === 1 && !body.input.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type))) throw new Error("TEST_HISTORY_MISSING");
  const command = globalThis.lcodexTestCommand ?? "& 'C:/nvm4w/nodejs/node.exe' --preserve-symlinks --preserve-symlinks-main --test; exit $LASTEXITCODE";
  const patch = "*** Begin Patch\n*** Update File: catalog.mjs\n@@\n-export function total(items) { return items.reduce((sum, item) => sum + item.unitCents, 0); }\n+export function total(items) { return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0); }\n*** End Patch";
  const message = connecting || (writeMode ? step >= 4 : n >= 2);
  const text = "模拟模型联测：已处理 catalog.mjs，实际工具结果见记录。原项目等待审阅后应用。";
  const item = stopping ? { id: `item-${n}`, type: "function_call", name: "exec_command", call_id: `call-${n}`, status: "completed", arguments: JSON.stringify({ cmd: "& 'C:/nvm4w/nodejs/node.exe' --preserve-symlinks --preserve-symlinks-main './process-tree.mjs' parent; exit $LASTEXITCODE", shell, login: false, workdir: cwd, yield_time_ms: 10000, max_output_tokens: 2048 }) }
    : message ? { id: `message-${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
    : writeMode && step === 2 ? { id: `item-${n}`, type: "custom_tool_call", name: "apply_patch", call_id: `call-${n}`, status: "completed", input: patch }
    : { id: `item-${n}`, type: "function_call", name: "exec_command", call_id: `call-${n}`, status: "completed", arguments: JSON.stringify({ cmd: readBeforeChecks && step === 0 ? "Get-Content -LiteralPath './catalog.mjs' -Raw" : writeMode ? command : `try { [IO.File]::WriteAllText(${quote(cwd + "/read-only-marker.txt")}, 'unexpected'); Write-Output 'UNEXPECTED_WRITE' } catch { Write-Output 'READ_ONLY_DENIED' }; Get-Content -LiteralPath './catalog.mjs' -Raw`, shell, login: false, workdir: cwd, yield_time_ms: 10000, max_output_tokens: 2048 }) };
  item.id += "-" + callSuffix;
  if (item.call_id) item.call_id += "-" + callSuffix;
  if (continuing && item.type === "function_call") { const args = JSON.parse(item.arguments); args.cmd += "; Get-Content -LiteralPath './latest-note.txt' -Raw"; item.arguments = JSON.stringify(args); }
  const response = { id: `mock-${n}-${callSuffix}`, object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 50, output_tokens: connecting ? 8 : 100, total_tokens: connecting ? 58 : 150 } };
  const events = [{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: message ? { ...item, content: [], status: "in_progress" } : item },
    ...(message ? [{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text }, { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }] : []),
    { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
  const wire = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
  return new Response(wire, { headers: { "content-type": "text/event-stream" } });
};
