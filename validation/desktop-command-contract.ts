import { isObject } from "./rpc.js";
import { ResponsesStream } from "./responses-stream.js";
import { prepareSerialResponse } from "./serial-response.js";
import { projectToolPolicy } from "./project-tool-policy.js";

type Options = { workspace: string; shell: string; rootMarker: string; readOnlyAssets: readonly string[]; readOnly: boolean; verifyCommand?: string };
function requireValue(value: unknown, code = "PROJECT_COMMAND_CONTRACT_REFUSED"): asserts value {
  if (!value) throw new Error(code);
}

// Only the command is a model decision. Execution parameters belong to the host.
// This contract narrows the native tool; it does not parse or grant shell rights.
export function desktopCommandContract(options: Options) {
  const native = projectToolPolicy(options.workspace, options.shell, options.rootMarker, options.readOnlyAssets);
  const commandArguments = (cmd: unknown) => ({
    cmd, shell: options.shell, login: false, workdir: options.workspace,
    yield_time_ms: 30000, max_output_tokens: 1024,
  });
  const policy = {
    functionCall(name: string, args: Record<string, unknown>) {
      requireValue(name === "exec_command" && Object.keys(args).length === 1 && Object.hasOwn(args, "cmd"));
      native.functionCall(name, commandArguments(args.cmd));
      requireValue(options.verifyCommand === undefined || args.cmd === options.verifyCommand, "TASK_VERIFICATION_REQUIRED");
    },
    patch(input: string) {
      requireValue(!options.readOnly, "TASK_READ_ONLY");
      requireValue(options.verifyCommand === undefined, "TASK_VERIFICATION_REQUIRED");
      native.patch(input);
    },
  };
  return {
    tools(engineTools: Record<string, unknown>[]) {
      requireValue(engineTools.some(tool => tool.type === "function" && tool.name === "exec_command"), "PROJECT_COMMAND_TOOL_MISSING");
      return [
        { type: "function", name: "exec_command",
          description: "Run a command in the selected isolated project. The host fixes PowerShell, working directory, no login shell, 1024 output tokens and bounded execution. Supply only cmd. First locate relevant functions/line numbers, then read short targeted ranges (normally at most 60 lines); never dump whole large files. Do not reread already observed ranges. Run the configured verification command separately, exactly as given.",
          parameters: { type: "object", properties: { cmd: { type: "string", maxLength: 8192,
            ...(options.verifyCommand === undefined ? {} : { enum: [options.verifyCommand] }) } },
          required: ["cmd"], additionalProperties: false } },
        ...(!options.readOnly && options.verifyCommand === undefined
          ? engineTools.filter(tool => tool.type === "custom" && tool.name === "apply_patch").map(tool => structuredClone(tool)) : []),
      ];
    },
    response(wire: string, response: Record<string, unknown>) {
      // Validate the complete upstream stream, including later calls, before
      // adapting anything. Rejected operations are never exposed to the engine.
      const validated = prepareSerialResponse(wire, response, policy);
      requireValue(options.verifyCommand === undefined || validated.calls.length <= 1, "TASK_VERIFICATION_REQUIRED");
      const mapped = new Map<string, string>();
      const output = (response.output as Record<string, unknown>[]).map(item => {
        if (item.type !== "function_call") return structuredClone(item);
        const args = JSON.parse(String(item.arguments)) as Record<string, unknown>;
        const argumentsText = JSON.stringify(commandArguments(args.cmd));
        mapped.set(String(item.id), argumentsText);
        return { ...item, arguments: argumentsText };
      });
      const adapted = { ...response, output }, events: Record<string, unknown>[] = [];
      const emitted = new Set<string>();
      const parser = new ResponsesStream(event => {
        const type = String(event.type), id = String(event.item_id);
        if (type === "response.completed") event = { ...event, response: adapted };
        else if (["response.output_item.added", "response.output_item.done"].includes(type) && isObject(event.item) && mapped.has(String(event.item.id))) {
          // Preserve an initially empty argument buffer; completed items always
          // contain the same arguments as the final response.
          event = { ...event, item: { ...event.item, arguments: type.endsWith(".added") && event.item.arguments === ""
            ? "" : mapped.get(String(event.item.id)) } };
        } else if (type === "response.function_call_arguments.delta" && mapped.has(id)) {
          event = { ...event, delta: emitted.has(id) ? "" : mapped.get(id) }; emitted.add(id);
        } else if (type === "response.function_call_arguments.done" && mapped.has(id)) {
          event = { ...event, arguments: mapped.get(id) };
        }
        events.push(event);
      });
      parser.push(wire); parser.finish();
      const adaptedWire = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      // Recheck the executable stream against the existing native boundary.
      return { response: adapted, batch: prepareSerialResponse(adaptedWire, adapted, {
        functionCall: native.functionCall, patch: policy.patch,
      }) };
    },
  };
}

// The engine keeps the full executable history. The model receives the matching
// cmd-only tool contract; IDs, command text, results and reasoning are retained.
export function desktopCommandHistory(input: unknown) {
  requireValue(Array.isArray(input), "API_COMMAND_HISTORY_INVALID");
  return input.map(item => {
    if (!isObject(item) || item.type !== "function_call" || item.name !== "exec_command") return item;
    requireValue(typeof item.arguments === "string", "API_COMMAND_HISTORY_INVALID");
    const args: unknown = JSON.parse(item.arguments);
    requireValue(isObject(args) && typeof args.cmd === "string", "API_COMMAND_HISTORY_INVALID");
    return { ...item, arguments: JSON.stringify({ cmd: args.cmd }) };
  });
}
