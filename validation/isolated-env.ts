import path from "node:path";

export function isolatedEnvironment(root: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Allowlist: do not inherit API keys, login tokens, proxy credentials or NODE_OPTIONS.
  for (const name of ["SystemRoot", "WINDIR", "PATH", "COMSPEC", "PATHEXT"]) {
    const value = Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    CODEX_HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "profile"),
    HOME: path.join(root, "profile"),
    APPDATA: path.join(root, "profile", "roaming"),
    LOCALAPPDATA: path.join(root, "profile", "local"),
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
}
