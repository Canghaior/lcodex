import { DESKTOP_MODEL } from "../../validation/deepseek-model.js";

export type ProviderId = "deepseek" | "openai";
export type Currency = "CNY" | "USD";
export const PROVIDERS = ["deepseek", "openai"] as const;
export const OPENAI_MODEL = {
  id: "gpt-6.2-astra", version: "gpt-6.2-astra", label: "GPT-6.2 Astra",
  effort: "high", maxOutputTokens: 8192, inputMicrosPerToken: 8, outputMicrosPerToken: 40,
} as const;
export function isProvider(value: unknown): value is ProviderId { return value === "deepseek" || value === "openai"; }
export function providerProfile(provider: ProviderId = "deepseek") {
  if (!isProvider(provider)) throw new Error("MODEL_PROVIDER_INVALID");
  return provider === "openai"
    ? { ...OPENAI_MODEL, provider, providerLabel: "OpenAI", currency: "USD" as const, symbol: "$", endpoint: "https://api.openai.com/v1/responses", priceSource: "https://developers.openai.com/api/docs/models/gpt-6.2-astra", priceDate: "2026-11-25" }
    : { ...DESKTOP_MODEL, provider, providerLabel: "DeepSeek", currency: "CNY" as const, symbol: "¥", endpoint: "https://api.deepseek.com/responses", priceSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", priceDate: "2026-10-20" };
}
export function validProviderKey(key: unknown, provider: ProviderId = "deepseek"): key is string {
  return typeof key === "string" && new RegExp(`^sk-[A-Za-z0-9_-]{16,${provider === "openai" ? 512 : 200}}$`).test(key);
}
