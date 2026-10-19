// Test teardown must let the product finish stopping before requesting window
// close. Otherwise its deliberate "needs reconciliation" dialog keeps the test
// window alive and hides the original assertion/readiness failure.
export async function stopAndCloseDesktop(application) {
  if (!application || application.process().exitCode !== null) return;
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
