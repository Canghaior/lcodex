// P1-only metadata, matched to the 0.140.0 ModelInfo schema. This is our small
// validation instruction, not a claim that an OpenAI prompt/model is reproduced.
export function validationCatalog(shellEnabled = false, readonlyTask = false, patchEnabled = false) {
  return { models: [{
    slug: "deepseek-flash", display_name: "DeepSeek Flash (P1 validation)",
    description: "Bounded text-only compatibility probe; not a released model configuration.",
    default_reasoning_level: "none", supported_reasoning_levels: [{ effort: "none", description: "No thinking for the initial protocol probe" }],
    shell_type: shellEnabled ? "shell_command" : "disabled", visibility: "list", supported_in_api: true, priority: 1,
    base_instructions: patchEnabled
      ? "You are a coding assistant working in a synthetic project. Apply only the bounded patch requested by the user. Use apply_patch, never shell commands. Preserve unrelated files. Report uncertainty honestly."
      : readonlyTask
      ? "You are a coding assistant analysing a synthetic project. Follow the user's read-only task. Read the requested file using the one permitted command, then answer from the observed content. Do not modify files or call other tools."
      : "You are assisting with a synthetic local validation task. Follow the user's bounded request. Explain uncertainty honestly. This initial probe permits only text answers; do not call tools.",
    supports_reasoning_summaries: true, default_reasoning_summary: "none", support_verbosity: false,
    apply_patch_tool_type: patchEnabled ? "freeform" : null, truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: false, context_window: 32_768, max_context_window: 32_768,
    experimental_supported_tools: [], input_modalities: ["text"], tool_mode: "direct",
  }] };
}
