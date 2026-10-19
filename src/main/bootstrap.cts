const { app, dialog } = require("electron") as typeof import("electron");
// The small CommonJS entry also reports failures before the ESM application's
// own error handling is loaded. Never log configuration contents or credentials.
try { require("./index.js"); } catch (error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "MODULE_LOAD";
  console.error("LCODEX_START_FAILED", code, error instanceof Error ? error.name : "Error");
  dialog.showErrorBox("lcodex 无法加载", "应用文件缺失或无法加载（" + code + "）。请重新安装应用，保留原有聊天数据。");
  app.exit(1);
}
