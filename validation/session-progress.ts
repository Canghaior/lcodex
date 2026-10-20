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
  verificationOnly(request: number) {
    return this.write && !!this.testCommand && request === TASK_LIMITS.requests - 1 && this.currentVerification !== 0;
  }
  instruction(request: number) {
    const remaining = Math.max(0, TASK_LIMITS.requests - request);
    return [
      `Current model request ${request}/${TASK_LIMITS.requests}. Including this request, at most ${remaining} tool-capable responses remain; request ${TASK_LIMITS.requests} is only for the final answer.`,
      "Use the provided project file index and read named files first. Do not spend separate calls listing directories already indexed. Combine focused source, test and README excerpts into one bounded read. The command tool accepts only cmd; execution parameters are host-owned.",
      this.write ? "Combine related source and test changes in a single apply_patch call where possible. Budget the remaining calls for verification and any necessary repair; avoid optional reads after a successful final verification." : "Answer the original questions from the files actually read. Snapshot-external imports remain unavailable; state that limit instead of searching outside.",
      this.write && this.testCommand ? `Configured verification command (exact cmd): ${JSON.stringify(this.testCommand)}. ${this.checked
        ? `Last actual verification exit code: ${this.lastVerification}; ${this.currentVerification === 0 ? "no later tool has invalidated that check." : "a current successful verification is still required."}`
        : "No matching verification has run yet. Run it before editing and again after the final modification, as a separate command."}` : "No whole-task test result is implied by a model answer.",
      this.verificationOnly(request) ? "This is the last tool-capable request. Only the configured verification command is available now. Run it if needed; no further edits or exploratory commands are allowed." : "",
      remaining <= 2 && this.write ? "Stop expanding the change now. Finish the necessary patch and leave room for the exact verification command before the final answer." : "",
    ].filter(Boolean).join("\n");
  }
}
