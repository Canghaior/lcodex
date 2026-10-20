import { TASK_LIMITS } from "./task-limits.js";
import { isObject } from "./rpc.js";

export function assertFinalAnswer(output: unknown) {
  if (!Array.isArray(output)) return;
  for (const item of output) if (isObject(item) && item.type === "message" && Array.isArray(item.content)) {
    const text = item.content.filter(isObject).map(part => part.type === "output_text" ? String(part.text ?? "") : "").join("");
    if (/^\s*<[\uFF5C|]+DSML[\uFF5C|]+tool_calls>/.test(text)) throw new Error("TASK_FINAL_ANSWER_INVALID");
  }
}

// Observed execution facts used to guide the existing engine loop, never a
// second scheduler or an inference from the model's own completion claims.
export class SessionProgress {
  private commands = new Map<string, string>();
  private checked = false;
  private currentVerification: number | null = null;
  private lastVerification: number | null = null;
  constructor(private readonly testCommand: string, private readonly write: boolean) {}
  plan(id: string, command: string) { this.commands.set(id, command); }
  started() { this.currentVerification = null; }
  completed(result: { id: string; type: string; exitCode: number | null }) {
    if (this.testCommand && result.type === "commandExecution" && this.commands.get(result.id) === this.testCommand && Number.isInteger(result.exitCode)) {
      this.checked = true; this.currentVerification = result.exitCode; this.lastVerification = result.exitCode;
    } else this.currentVerification = null;
  }
  verificationOnly(request: number, remainingTools: number = TASK_LIMITS.tools, remainingRounds: number = TASK_LIMITS.toolRounds) {
    return this.write && !!this.testCommand && request < TASK_LIMITS.requests && remainingTools > 0 && remainingRounds > 0 &&
      (request === TASK_LIMITS.requests - 1 || remainingTools === 1 || remainingRounds === 1) && this.currentVerification !== 0;
  }
  instruction(request: number, remainingTools: number = TASK_LIMITS.tools, remainingRounds: number = TASK_LIMITS.toolRounds) {
    const remaining = remainingTools && remainingRounds ? Math.max(0, TASK_LIMITS.requests - request) : 0;
    return [
      `Current model request ${request}/${TASK_LIMITS.requests}. Including this request, at most ${remaining} tool-capable responses remain; request ${TASK_LIMITS.requests} is only for the final answer.`,
      `Remaining tool calls: ${remainingTools}/${TASK_LIMITS.tools}; remaining tool batches: ${remainingRounds}/${TASK_LIMITS.toolRounds}. Never request more calls than remain. ${remaining === 0 ? "No further tools are available; give the final answer from observed evidence now." : "Leave enough capacity to cover every requested question and verification."}`,
      "Use the provided file index. For large files, locate the named functions and their line numbers first, then read only necessary ranges, normally at most 60 lines. Never dump full large files or repeat ranges already read: command output is capped at 1024 tokens and truncation wastes context and budget. Read only the files needed to answer the user's questions. The command tool accepts only cmd; execution parameters are host-owned.",
      this.write ? "Combine related source and test changes in a single apply_patch call where possible. Budget the remaining calls for verification and any necessary repair; avoid optional reads after a successful final verification." : "Cover each part of the user's question before drilling deeper into one file. You may group independent, short read commands for different parts in the same response; the host executes them serially, never concurrently. Answer from the files actually read. Snapshot-external imports remain unavailable; state that limit instead of searching outside.",
      this.write && this.testCommand ? `Configured verification command (exact cmd): ${JSON.stringify(this.testCommand)}. ${this.checked
        ? `Last actual verification exit code: ${this.lastVerification}; ${this.currentVerification === 0 ? "no later tool has invalidated that check." : "a current successful verification is still required."}`
        : "No matching verification has run yet. Run it before editing and again after the final modification, as a separate command."}` : "No whole-task test result is implied by a model answer.",
      this.verificationOnly(request, remainingTools, remainingRounds) ? "This is the last tool-capable request. Only the configured verification command is available now. Run it if needed; no further edits or exploratory commands are allowed." : "",
      remaining <= 2 && this.write ? "Stop expanding the change now. Finish the necessary patch and leave room for the exact verification command before the final answer." : "",
    ].filter(Boolean).join("\n");
  }
}
