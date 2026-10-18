import vm from "node:vm";

export const INVOICE_BASELINE = "export function invoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.priceCents, 0);\n}\n";
function check(value: unknown): asserts value { if (!value) throw new Error("PROBE_PATCH_CONTRACT_REFUSED"); }

// A deliberately narrow language for this arithmetic fixture. Neither the patch
// nor a model-edited module is allowed to become an unrestricted Node program.
function checkExpression(expression: string, names: string[]) {
  check(expression.length <= 200);
  const tokens = expression.match(/[A-Za-z_$][\w.$]*|[0-9]+(?:\.[0-9]+)?|[()+*/%-]|\s+/g);
  check(tokens && tokens.join("") === expression && tokens.every((token) =>
    /^\s+$/.test(token) || /^[0-9]+(?:\.[0-9]+)?$/.test(token) || /^[()+*/%-]$/.test(token) || names.includes(token)));
  // No invocation of identifiers, increment/decrement, or comments.
  check(!/[A-Za-z_$][\w.$]*\s*\(|\+\+|--|\/[/*]/.test(expression));
}

export function checkInvoiceSource(source: string) {
  const match = /^export function invoiceTotal\(items\) \{\s*return items\.reduce\(\(sum, item\) => (.+), 0\);\s*\}\s*(?:export function applyDiscount\(cents, percent\) \{\s*return Math\.round\((.+)\);\s*\}\s*)?$/.exec(source);
  check(match && match[1]);
  checkExpression(match[1], ["sum", "item.priceCents", "item.quantity"]);
  if (match[2]) checkExpression(match[2], ["cents", "percent"]);
}

export function previewInvoicePatch(patch: string, baseline = INVOICE_BASELINE): string {
  check(Buffer.byteLength(patch) <= 4096 && !patch.includes("\r") && !patch.includes("\0"));
  const lines = patch.trimEnd().split("\n");
  check(lines.shift() === "*** Begin Patch" && lines.shift() === "*** Update File: invoice.mjs" && lines.pop() === "*** End Patch");
  check(lines.shift()?.startsWith("@@") && lines.length > 0);
  check(lines.every((line) => /^[ +\-]/.test(line)));
  const oldText = lines.filter((line) => line[0] !== "+").map((line) => line.slice(1)).join("\n") + "\n";
  const newText = lines.filter((line) => line[0] !== "-").map((line) => line.slice(1)).join("\n") + "\n";
  const index = baseline.indexOf(oldText);
  check(oldText.trim() && index >= 0 && baseline.indexOf(oldText, index + 1) === -1);
  const candidate = baseline.slice(0, index) + newText + baseline.slice(index + oldText.length);
  checkInvoiceSource(candidate);
  return candidate;
}

export function evaluateInvoiceSource(source: string) {
  checkInvoiceSource(source);
  const script = new vm.Script(source.replaceAll("export function ", "function ") + "\n" +
    "([invoiceTotal([]),invoiceTotal([{priceCents:125,quantity:1}]),invoiceTotal([{priceCents:125,quantity:4}])," +
    "invoiceTotal([{priceCents:125,quantity:2},{priceCents:80,quantity:3}])," +
    "typeof applyDiscount === 'function' ? applyDiscount(1000,15) : null," +
    "typeof applyDiscount === 'function' ? applyDiscount(105,10) : null])");
  const actual: unknown = script.runInNewContext(Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
  check(Array.isArray(actual) && actual.length === 6);
  const expected = [0, 125, 500, 490, 850, 95];
  const names = ["empty", "single", "quantity", "mixed", "discount", "rounding"];
  return expected.map((value, index) => ({ name: names[index], passed: actual[index] === value }));
}
