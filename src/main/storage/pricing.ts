import { existsSync } from "node:fs";
import path from "node:path";
import { PRICE_REVIEW_DATE } from "../../../validation/deepseek-request.js";
import { DESKTOP_MODEL } from "../../../validation/deepseek-model.js";
import { readPrivate, writePrivate } from "../../../validation/private-files.js";
import { providerProfile, type ProviderId } from "../../shared/providers.js";

export const PRICE_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
export const PRICE_REFERENCE = `${DESKTOP_MODEL.id}:${DESKTOP_MODEL.version}:CNY:input-${DESKTOP_MODEL.inputMicrosPerToken}:output-${DESKTOP_MODEL.outputMicrosPerToken}:per-million`;
export function localDay(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
export class Pricing {
  private readonly profile;
  private readonly file;
  private readonly reference;
  constructor(private root: string, private development: boolean, provider: ProviderId = "deepseek") {
    this.profile = providerProfile(provider);
    this.file = provider === "deepseek" ? "pricing.json" : "openai-pricing.json";
    this.reference = provider === "deepseek" ? PRICE_REFERENCE : "gpt-6.2-astra:2026-11-25:USD:input-8:output-40:standard:no-cache-writes";
  }
  status(today = localDay()) {
    let confirmedOn = this.development && this.profile.provider === "deepseek" ? PRICE_REVIEW_DATE : "";
    if (existsSync(path.join(this.root, this.file))) {
      try {
        const saved = JSON.parse(readPrivate(this.root, this.file));
        if (saved.reference === this.reference && typeof saved.confirmedOn === "string") confirmedOn = saved.confirmedOn;
        else confirmedOn = "";
      } catch { confirmedOn = ""; }
    }
    return { confirmedOn, current: confirmedOn === today, source: this.profile.priceSource, reference: this.reference };
  }
  confirm() { writePrivate(this.root, this.file, JSON.stringify({ reference: this.reference, confirmedOn: localDay() })); }
  requireCurrent() { const state = this.status(); if (!state.current) throw new Error("PRICE_REVIEW_REQUIRED"); return state.confirmedOn; }
}
