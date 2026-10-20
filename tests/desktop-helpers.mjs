import { terminateOwnedProcessTree } from "../dist/validation/process-tree-stop.js";

// Fresh-profile startup happens before configuring a key or starting a task.
// A native startup-error dialog can block Electron's event loop and normal
// close, so terminate only this test's owned child tree on readiness failure.
export async function waitForFreshDesktop(application) {
  const child = application.process();
  let timer, onError;
  const failed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("DESKTOP_TEST_STARTUP_TIMEOUT")), 40000);
    onError = data => {
      const code = data.toString().match(/LCODEX_START_FAILED(?: (START_[A-Z0-9_]{1,90}))?/);
      if (code) reject(new Error(code[1] ?? "DESKTOP_TEST_STARTUP_FAILED"));
    };
    child.stderr?.on("data", onError);
  });
  try {
    return await Promise.race([failed, (async () => {
      const page = await application.firstWindow({ timeout: 40000 });
      await page.getByRole("heading", { name: "从一个本地项目开始" }).waitFor({ timeout: 40000 });
      return page;
    })()]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      await terminateOwnedProcessTree(child);
      await new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const exitTimer = setTimeout(() => reject(new Error("DESKTOP_TEST_STARTUP_EXIT_UNKNOWN")), 5000);
        child.once("exit", () => { clearTimeout(exitTimer); resolve(); });
      });
    }
    throw error;
  } finally {
    clearTimeout(timer); child.stderr?.off("data", onError);
  }
}

// Test teardown must let the product finish stopping before requesting window
// close. Otherwise its deliberate "needs reconciliation" dialog keeps the test
// window alive and hides the original assertion/readiness failure.
export async function stopAndCloseDesktop(application) {
  if (!application || application.process().exitCode !== null || application.process().signalCode !== null) return;
  const page = await application.firstWindow();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const reply = await page.evaluate(() => window.lcodex.request({ type: "snapshot" }));
    const active = reply.ok ? reply.state.chats.find(chat => ["running", "waiting", "stopping"].includes(chat.execution)) : undefined;
    if (!active) { await application.close(); return; }
    if (active.execution !== "stopping") await page.evaluate(chatId => window.lcodex.request({ type: "stop", chatId }), active.id);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("DESKTOP_TEST_TEARDOWN_REQUIRES_RECONCILIATION");
}
