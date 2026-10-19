import { useEffect, useState } from "react";
import type { AppState, Command, Reply } from "../shared/contracts.js";

export function BudgetSettings({ state, disabled, request }: { state: AppState | null; disabled: boolean; request: (command: Command) => Promise<Reply | undefined> }) {
  const [total, setTotal] = useState("10"), [trial, setTrial] = useState("1"), [busy, setBusy] = useState(false);
  const budget = state?.budget;
  useEffect(() => { if (budget) { setTotal(String(budget.limit)); setTrial(String(budget.perTask)); } }, [budget?.limit, budget?.perTask]);
  const act = async (command: Command) => { setBusy(true); try { await request(command); } finally { setBusy(false); } };
  const blocked = disabled || busy;
  return <>
    <div className="settings-section"><h3>{budget?.scope === "personal" ? "使用预算" : "开发验证预算"}</h3>
      <div className="setting-row"><span>累计占用 / 上限</span><span>¥{budget?.committed.toFixed(4)} / ¥{budget?.limit}</span></div>
      <p>估算消耗 ¥{budget?.estimated.toFixed(4)}；已按上限记入的未知用量 ¥{budget?.unknown.toFixed(4)}；在途或待核对预留 ¥{budget?.pendingCost.toFixed(4)}。实际账单未查询。</p>
      <p>单任务最多 ¥{budget?.perTask}、8 次模型请求、12 次工具调用、8 轮工具；命令最长 45 秒，任务最长 180 秒，连续 2 次工具失败停止。触顶保留结果，不自动重试。</p>
      {budget?.scope === "personal" ? <><p>累计上限包含此前消耗，不按天重置。每次明确发送新任务才获得新的单任务限额；修改上限不清空账本。</p>
        <label className="setting-label" htmlFor="budget-total">累计预算上限（元）</label><input id="budget-total" type="number" min="0.25" max="1000" step="0.01" value={total} onChange={event => setTotal(event.target.value)} />
        <label className="setting-label" htmlFor="budget-trial">单任务上限（元）</label><input id="budget-trial" type="number" min="0.25" max="1000" step="0.01" value={trial} onChange={event => setTrial(event.target.value)} />
        <button disabled={blocked || !Number.isFinite(Number(total)) || Number(trial) < 0.25 || Number(total) < Number(trial)} onClick={() => void act({ type: "configure-budget", totalMicros: Math.round(Number(total) * 1_000_000), trialMicros: Math.round(Number(trial) * 1_000_000) })}>{budget.configured ? "保存预算上限" : "确认并启用预算"}</button></>
        : <p>开发测试继续共用原已授权的累计 ¥10、单次 ¥1，不能在这里增加或重置。</p>}
      {!!budget?.pending && <><p>有 {budget.pending} 笔请求用量未确认，当前禁止新调用。可以将预留 ¥{budget.pendingCost.toFixed(4)} 全额计入累计及原任务占用，再手动决定下一步；这不会重试请求，也不表示已核对账单。</p><button disabled={blocked} onClick={() => void act({ type: "account-unknown", revision: budget.revision })}>按预留全额记入未知用量</button></>}
      {budget?.error && <><p>预算暂不可用（{budget.error}）。账本和已有占用保留；仅原持有进程已退出且锁归属可验证时，才允许解除遗留锁。</p><button disabled={blocked} onClick={() => void act({ type: "recover-budget-lock" })}>核对已退出的预算进程</button></>}
    </div>
    <div className="settings-section"><h3>价格参考</h3><p>DeepSeek Flash · DeepSeek-V4.1-Flash-1017。按高峰、无缓存价格估算：每百万输入 tokens ¥2，输出 ¥8；每次请求预留 ¥0.25。实际扣费可能较低。</p>
      <p>记录日期：{state?.pricing.confirmedOn || "尚未确认"}。{state?.pricing.current ? "今日参考价格已确认。" : "请核对官方价格和对应模型。价格或模型发生变化时，请先停止使用并更新适配。"}</p>
      <button disabled={blocked} onClick={() => void act({ type: "open-pricing" })}>查看 DeepSeek 官方价格</button>
      {!state?.pricing.current && <button disabled={blocked} onClick={() => void act({ type: "confirm-price" })}>已核对今日价格与上述记录一致</button>}
      <p>每天首次使用时核对；确认不会调用模型或改变预算。云端计费和在途请求不能由本地估算精确控制。</p>
    </div>
  </>;
}
