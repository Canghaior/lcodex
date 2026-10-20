// Official CNY peak / cache-miss prices reviewed 2026-10-20.
// Keep the earlier profile for reproducible P1 probes, not automatic fallback.
export const FLASH_MODEL = {
  id: "deepseek-flash", version: "DeepSeek-V4.1-Flash-1017", label: "DeepSeek Flash",
  effort: "none", maxOutputTokens: 1024, inputMicrosPerToken: 2, outputMicrosPerToken: 8,
} as const;

export const DESKTOP_MODEL = {
  id: "deepseek-v4-pro", version: "DeepSeek-V4-Pro-0813", label: "DeepSeek V4 Pro",
  effort: "high", maxOutputTokens: 8192, inputMicrosPerToken: 9, outputMicrosPerToken: 27,
} as const;

export function deepSeekModel(id: unknown) {
  if (id === FLASH_MODEL.id) return FLASH_MODEL;
  if (id === DESKTOP_MODEL.id) return DESKTOP_MODEL;
  throw new Error("API_REQUEST_BOUNDS_REQUIRED");
}
