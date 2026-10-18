// A last check for credentials known to this process. File permissions remain
// necessary: this cannot recognize arbitrary secrets or every transformation.
export function assertNoKnownSecrets(body: string, values: readonly string[]): void {
  for (const value of values) {
    if (value.length < 16) throw new Error("API_SECRET_GUARD_CONFIGURATION");
    const variants = [value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), encodeURIComponent(value)];
    if (variants.some((variant) => body.includes(variant))) throw new Error("API_SENSITIVE_INPUT_REFUSED");
  }
}
