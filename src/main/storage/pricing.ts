import { existsSync } from "node:fs";
import path from "node:path";
import { PRICE_REVIEW_DATE } from "../../../validation/deepseek-request.js";
import { DESKTOP_MODEL } from "../../../validation/deepseek-model.js";
import { readPrivate, writePrivate } from "../../../validation/private-files.js";

export const PRICE_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
export const PRICE_REFERENCE = `${DESKTOP_MODEL.id}:${DESKTOP_MODEL.version}:CNY:input-${DESKTOP_MODEL.inputMicrosPerToken}:output-${DESKTOP_MODEL.outputMicrosPerToken}:per-million`;
export function localDay(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
export class Pricing {
  constructor(private root: string, private development: boolean) {}
  status(today = localDay()) {
    let confirmedOn = this.development ? PRICE_REVIEW_DATE : "";
    if (existsSync(path.join(this.root, "pricing.json"))) {
      try {
        const saved = JSON.parse(readPrivate(this.root, "pricing.json"));
        if (saved.reference === PRICE_REFERENCE && typeof saved.confirmedOn === "string") confirmedOn = saved.confirmedOn;
        else confirmedOn = "";
      } catch { confirmedOn = ""; }
    }
    return { confirmedOn, current: confirmedOn === today, source: PRICE_SOURCE, reference: PRICE_REFERENCE };
  }
  confirm() { writePrivate(this.root, "pricing.json", JSON.stringify({ reference: PRICE_REFERENCE, confirmedOn: localDay() })); }
  requireCurrent() { const state = this.status(); if (!state.current) throw new Error("PRICE_REVIEW_REQUIRED"); return state.confirmedOn; }
}
