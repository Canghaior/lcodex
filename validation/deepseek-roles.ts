import { isObject } from "./rpc.js";

// Only the authenticated engine request reaches this adapter. Project documents
// are already user content in the pinned engine and are never promoted here.
export function mapDeepSeekRoles(request: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(request.input)) throw new Error("API_ROLE_INPUT_REQUIRED");
  return { ...request, input: request.input.map((item: unknown) => {
    if (!isObject(item)) throw new Error("API_ROLE_ITEM_REQUIRED");
    if (item.role !== "developer") return item;
    if (item.type !== undefined && item.type !== "message") throw new Error("API_ROLE_TYPE_REFUSED");
    return { ...item, role: "system" };
  }) };
}
