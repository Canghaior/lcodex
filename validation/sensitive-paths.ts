import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

// Metadata-only P1 inventory. Explicit patterns are conservative, not a secret
// detector. The caller must enforce returned paths at the execution boundary.
export function sensitivePaths(project: string, maxEntries = 4096): string[] {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("SENSITIVE_INVENTORY_INVALID_LIMIT");
  if (lstatSync(project).isSymbolicLink()) throw new Error("SENSITIVE_INVENTORY_LINK_REFUSED");
  const root = realpathSync(project);
  const denied: string[] = [];
  let entries = 0;
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      if (++entries > maxEntries) throw new Error("SENSITIVE_INVENTORY_LIMIT");
      const file = path.join(directory, name), stat = lstatSync(file), lower = name.toLowerCase();
      if (stat.isSymbolicLink()) throw new Error("SENSITIVE_INVENTORY_LINK_REFUSED");
      if (stat.isDirectory()) {
        if ([".ssh", ".aws", ".azure", ".kube", ".gnupg"].includes(lower)) denied.push(file);
        else if (lower === ".git") {
          const config = path.join(file, "config");
          if (existsSync(config)) {
            if (lstatSync(config).isSymbolicLink()) throw new Error("SENSITIVE_INVENTORY_LINK_REFUSED");
            denied.push(config);
          }
        } else visit(file);
      } else if (lower === ".env" || lower.startsWith(".env.") ||
        [".npmrc", ".pypirc", ".git-credentials", "credentials.json"].includes(lower) ||
        /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.test(lower) || /\.(pem|key|p12|pfx|keystore)$/.test(lower)) denied.push(file);
    }
  }
  visit(root);
  return denied.sort();
}
