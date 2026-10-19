import { BudgetSettings } from "./BudgetSettings.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ChevronRight, Code2, FileCode2, FileDiff, FileText, Folder, FolderOpen, ListChecks, Maximize2, MessageSquare, Minus, PanelLeft, PanelRight, Plus, Search, Settings2, ShieldCheck, Square, SquarePen, Terminal, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppState, Chat, Command, FilePreview, Reply } from "../shared/contracts.js";

const executionLabels = { idle: "尚未开始", running: "执行中", waiting: "等待确认", stopping: "正在停止", stopped: "已停止", failed: "失败", reconcile: "需要核对", ended: "已结束" };
const verificationLabels = { passed: "验证通过", failed: "验证失败", unverified: "尚未验证", "not-applicable": "不适用" };
function errorText(code: string) {
  const actionable: Record<string, string> = {
    GUARD_TEXT_LIMIT: "单文件超过当前上限（源码 1 MiB，普通依赖 16 MiB）。请选择范围内的项目。",
    GUARD_TOTAL_LIMIT: "项目超过当前总容量上限（源码与资源 16 MiB，普通依赖 64 MiB）。请先选择较小的项目。",
    GUARD_ENTRY_LIMIT: "项目文件或目录项过多，首版暂不能准备安全副本。",
    GUARD_TYPE_REFUSED: "项目含链接、硬链接或不支持的文件类型。首版只支持普通本地文件。",
    GUARD_PATH_ALIAS_REFUSED: "项目路径含重定向或短名别名，请通过实际本地路径重新选择。",
    REVIEW_DISK_LOW: "工作盘剩余空间不足 5 GiB。请释放空间后重试，已有记录不会自动删除。",
    REVIEW_DEPENDENCY_SENSITIVE_CONTENT: "依赖目录中发现受保护文件，无法安全复制。请检查依赖的本地凭据配置。",
    REVIEW_DEPENDENCY_CHANGED: "任务期间只读依赖发生变化，已保留记录并停止生成可应用改动。",
    PROJECT_OVERLAPS_APP_DATA: "项目目录不能包含应用数据目录，也不能位于其中。请选择独立的项目文件夹。",
    PROJECT_SCOPE_UNSUPPORTED: "修改任务目前只支持含 package.json 的小型单包 JS/TS 项目，暂不支持 workspace 多包。",
    PROJECT_LOCK_BUSY_RECONCILE_REQUIRED: "这个项目仍有待审阅或待核对任务。请先处理原任务，再开始新的修改。",
    TASK_ALREADY_RUNNING: "已有任务或文件应用正在进行，请等待结束或先停止它。",
    TASK_NEW_CHAT_REQUIRED: "这个任务已经结束；当前版本请新建聊天开始下一项任务。",
    TASK_RECONCILE_REQUIRED: "上次执行或审阅尚未核对。已有记录和文件基线保留，操作不会自动重放。",
    REVIEW_REOPEN_REQUIRED: "待应用改动已保留。请先核对并重开审阅；这不会调用模型或自动应用文件。",
    REVIEW_RECONCILE_REQUIRED: "无法确认上次写入结果。基线与冻结改动已保留，不会重放或覆盖原文件。",
    REVIEW_CONTENT_CHANGED: "审阅内容或应用记录发生变化，已阻止恢复。请保留记录供核对。",
    CHAT_DELETE_REFUSED: "请先结束任务并处理待审阅改动。存在未决写入时不能删除恢复依据。",
    CHAT_DELETE_INCOMPLETE: "这次删除尚未完成，记录已保留。请再次点击删除聊天以继续清理。",
    CHAT_DELETE_LINK_REFUSED: "本机任务数据中发现链接或路径变化，已停止清理；不会跟随链接删除其他位置。",
    CHAT_COUNT_LIMIT: "已达到 1000 个聊天的保存上限，请删除不再需要的已结束聊天。",
    TASK_ABANDON_RECONCILE_REQUIRED: "还不能确认引擎已安全退出，或者曾向原项目应用改动。记录与项目锁保留，请先核对。",
    TASK_ORIGINAL_WRITE_REQUIRES_RECONCILIATION: "存在原项目应用记录，不能通过放弃隔离尝试解除核对要求。",
    PROJECT_LOCK_OWNER_ACTIVE: "原任务的后台进程仍存在，暂不能解除项目锁。请先核对它已退出。",
    ENGINE_HISTORY_UNAVAILABLE: "引擎历史暂不可读取，不能确认这次操作的结果。项目锁和副本已保留，请勿通过删除记录解除保护。",
    TASK_ISOLATED_ABANDONED: "本次隔离尝试已结束，最后操作结果仍未确认。原项目没有应用本次改动，记录已保留；可以新建聊天。",
    TASK_REVIEW_OR_RECONCILE_REQUIRED: "请先应用或放弃待审阅改动；若状态需要核对，请先完成核对，再继续对话。",
    KEY_MISSING: "请先在设置中保存 DeepSeek API Key。",
    KEY_ENCRYPTION_UNAVAILABLE: "Windows 密钥加密当前不可用。请检查登录环境后重试，不会改用明文保存。",
    API_HTTP_401: "DeepSeek 未接受这个密钥。请检查设置；此次请求用量未知，预留预算已保留。",
    API_HTTP_402: "DeepSeek 账户额度不足，请检查账户余额。此次请求不会自动重试。",
    API_HTTP_429: "DeepSeek 暂时限流，请稍后检查。用量未知的预留仍保留，不会自动重试。",
    BUDGET_PENDING_RECONCILIATION: "有未确认用量的请求，预算账本已保留，核对前不会再调用模型。",
    BUDGET_LOCK_UNVERIFIED: "预算锁不存在或归属无法确认。已有账本保留，不能按零消耗重新开始。",
    BUDGET_LOCK_OWNER_ACTIVE: "持有预算锁的进程仍在运行，请先等待该任务结束。",
    BUDGET_RECONCILIATION_CHANGED: "待核对用量已变化，请重新查看设置后再操作。",
    BUDGET_WRONG_LIMITS: "请填写有效预算：单任务至少 ¥0.25，累计上限不少于单任务限额及已有占用。",
    BUDGET_TOTAL_LIMIT: "累计预算已到上限。已有结果保留，继续前需要调整预算授权。",
    BUDGET_TRIAL_LIMIT: "本次任务已达到设置的预算上限。已有结果保留，不再发送请求。",
    TASK_REQUEST_LIMIT: "本次任务达到 8 次模型请求上限。请查看已完成内容和未完成事项。",
    TASK_COMMAND_LIMIT: "命令超过 45 秒限制，已停止新操作并核对相关进程。",
    API_INPUT_SIZE_LIMIT: "当前对话超过已验证的上下文上限。请新建聊天并缩小任务范围。",
    PRICE_REVIEW_REQUIRED: "请在设置中核对并确认今日参考价格；确认前不会开始计费请求。",
  };
  if (actionable[code]) return actionable[code]!;
  const entries: Record<string, string> = { SHELL_UNAVAILABLE: "未找到已验证的 PowerShell。请在设置中检查执行环境。", GUARD_CAPTURE_REFUSED: "这个项目暂不符合首版的文件范围，请选择小型单包 JS/TS 项目。", GUARD_CAPACITY_REFUSED: "项目超过首版容量上限，请选择较小的项目。", GUARD_REPARSE_REFUSED: "项目包含链接或目录重定向，首版暂不支持。", FILE_UNAVAILABLE: "文件已变化或不再存在，请重新选择项目。", FILE_OUTSIDE_SELECTION: "这个文件不在已授权项目的可预览范围内。", ACTION_FAILED: "操作未完成，请重试；已有项目和任务记录已保留。" };
  return entries[code] ?? `操作未完成（${code}），已有内容已保留。`;
}
function IconButton({ label, children, onClick, className = "", disabled = false }: { label: string; children: React.ReactNode; onClick: () => void; className?: string; disabled?: boolean }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function App() {
  const [state, setState] = useState<AppState | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false), [sidebar, setSidebar] = useState(true), [workspace, setWorkspace] = useState(true), [tab, setTab] = useState<"files" | "changes" | "output">("files");
  const [keyInput, setKeyInput] = useState(""), [keyBusy, setKeyBusy] = useState(false), [testCommand, setTestCommand] = useState(""), [selectedChange, setSelectedChange] = useState<string | null>(null), [applying, setApplying] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false), [connectionVerified, setConnectionVerified] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null), [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null), [files, setFiles] = useState<FilePreview[]>([]), [sourceView, setSourceView] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [query, setQuery] = useState(""), [searching, setSearching] = useState(false);
  const [chatWidth, setChatWidth] = useState(45), [dragging, setDragging] = useState(false);
  const center = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), bottom = useRef<HTMLDivElement>(null);
  const chat = state?.chats.find(item => item.id === state.activeChatId);
  const project = state?.projects.find(item => item.id === chat?.projectId);
  const deleteTarget = state?.chats.find(item => item.id === deleteTargetId);
  const draft = drafts[chat?.id ?? "empty"] ?? "";
  const request = useCallback(async (command: Command): Promise<Reply | undefined> => {
    try { const reply = await window.lcodex.request(command); if (reply.ok) { setState(reply.state); return reply; } setError(errorText(reply.code)); }
    catch { setError("与本地后台的连接中断，请保留窗口并重试。"); }
  }, []);
  useEffect(() => { void request({ type: "snapshot" }); return window.lcodex.subscribe(setState); }, [request]);
  useEffect(() => { setPreview(null); setFiles([]); }, [project?.id]);
  useEffect(() => { setTestCommand(project?.testCommand ?? ""); }, [project?.id, project?.testCommand]);
  useEffect(() => { if (!settings) setKeyInput(""); }, [settings]);
  useEffect(() => { if (!state?.runtime.key) setConnectionVerified(false); }, [state?.runtime.key]);
  useEffect(() => { setSelectedChange(null); }, [chat?.id]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [chat?.messages.length, chat?.tools.length]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSettings(false); setSearching(false); }
      if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); setSidebar(value => !value); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => { const rect = center.current?.getBoundingClientRect(); if (rect) setChatWidth(Math.min(70, Math.max(30, (event.clientX - rect.left) / rect.width * 100))); };
    const end = () => setDragging(false);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
  }, [dragging]);
  async function chooseProject() { setBusy(true); try { await request({ type: "choose-project" }); } finally { setBusy(false); } }
  function startChat(projectId?: string) { if (projectId) void request({ type: "new-chat", projectId }); else void chooseProject(); }
  async function openFile(relative: string) {
    if (!project) return;
    const reply = await request({ type: "open-file", projectId: project.id, relative });
    if (reply?.ok && reply.file) { setPreview(reply.file); setFiles(old => [...old.filter(file => file.relative !== relative), reply.file!]); setTab("files"); setWorkspace(true); setSourceView(false); }
  }
  async function send() {
    if (!chat || !draft.trim()) return;
    if (!state?.runtime.ready) { setSettings(true); return; }
    const reply = await request({ type: "send", chatId: chat.id, text: draft.trim() });
    if (reply?.ok) setDrafts(old => ({ ...old, [chat.id]: "" }));
  }
  async function saveKey() {
    setKeyBusy(true);
    try { const reply = await request({ type: "set-key", key: keyInput.trim() }); if (reply?.ok) { setKeyInput(""); setConnectionVerified(false); } }
    finally { setKeyBusy(false); }
  }
  async function checkConnection() {
    setCheckingConnection(true); setConnectionVerified(false);
    try { const reply = await request({ type: "check-connection" }); if (reply?.ok && reply.connectionVerified) setConnectionVerified(true); }
    finally { setCheckingConnection(false); }
  }
  async function applyChanges(files: string[]) {
    if (!chat?.reviewId) return;
    setApplying(true); try { await request({ type: "apply", chatId: chat.id, reviewId: chat.reviewId, files }); } finally { setApplying(false); }
  }
  function markdown(text: string) { return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ href, children }) => <button className="text-link" onClick={() => { if (href && project?.files.includes(href.replace(/^\.\//, ""))) void openFile(href.replace(/^\.\//, "")); }}>{children}</button> }}>{text}</ReactMarkdown>; }
  const active = chat && ["running", "waiting", "stopping"].includes(chat.execution);
  const change = chat?.changes.find(change => change.relative === selectedChange) ?? chat?.changes[0];
  const pendingChanges = chat?.changes.filter(change => change.status === "pending") ?? [];
  const canCompose = !!chat && ["idle", "ended"].includes(chat.execution) && !chat.changes.some(change => ["pending", "needs-reconcile"].includes(change.status));
  return <div className={`desktop ${dragging ? "resizing" : ""}`}>
    <header className="titlebar"><div className="titlebar-left"><Terminal size={13} /><span>lcodex</span><span className="titlebar-divider">/</span><span>{project?.name ?? "本地编程助手"}</span></div><div className="window-controls">
      <IconButton label="最小化" onClick={() => void request({ type: "window", action: "minimize" })}><Minus size={14} /></IconButton>
      <IconButton label="最大化或还原" onClick={() => void request({ type: "window", action: "maximize" })}><Square size={12} /></IconButton>
      <IconButton label="关闭窗口" className="window-close" onClick={() => void request({ type: "window", action: "close" })}><X size={16} /></IconButton>
    </div></header>
    <div className="app-body">
      <nav className="rail" aria-label="主要导航"><button className="brand-mark" aria-label="聊天" onClick={() => setSidebar(true)}><Terminal size={20} /><i /></button><IconButton label="切换项目侧栏" onClick={() => setSidebar(value => !value)}><PanelLeft size={19} /></IconButton><IconButton label="新聊天" onClick={() => startChat(project?.id)}><SquarePen size={19} /></IconButton><div className="rail-spacer" /><IconButton label="设置" onClick={() => setSettings(true)}><Settings2 size={19} /></IconButton><span className="local-avatar" title="个人 · 本机">L</span></nav>
      {sidebar && <aside className="sidebar"><div className="sidebar-heading"><button className="app-name" onClick={() => setSettings(true)}>lcodex <ChevronDown size={13} /></button><IconButton label="搜索聊天" onClick={() => setSearching(value => !value)}><Search size={16} /></IconButton></div>
        <button className="sidebar-action" onClick={() => startChat(project?.id)}><SquarePen size={16} />新聊天<span>+</span></button>
        {searching && <div className="search-field"><Search size={14} /><input autoFocus aria-label="搜索聊天内容" placeholder="搜索聊天" value={query} onChange={event => setQuery(event.target.value)} /></div>}
        <div className="project-heading"><span>项目</span><IconButton label="添加项目" disabled={busy} onClick={() => void chooseProject()}><Plus size={15} /></IconButton></div>
        <div className="project-list">{state?.projects.map(item => <div className="project-group" key={item.id}><div className="project-row"><FolderOpen size={15} /><button title={item.path} onClick={() => { const first = state.chats.find(current => current.projectId === item.id); if (first) void request({ type: "select-chat", chatId: first.id }); else startChat(item.id); }}>{item.name}</button><IconButton label={`在 ${item.name} 中新建聊天`} onClick={() => startChat(item.id)}><Plus size={14} /></IconButton></div>{state.chats.filter(current => current.projectId === item.id && (!searching || current.title.toLowerCase().includes(query.toLowerCase()))).map(current => <button key={current.id} className={`chat-row ${current.id === chat?.id ? "selected" : ""}`} onClick={() => void request({ type: "select-chat", chatId: current.id })}><span className={`chat-dot ${current.execution}`} />{current.title}</button>)}</div>)}
          {state?.projects.length === 0 && <div className="sidebar-empty">添加一个本地项目，<br />开始你的第一段对话。</div>}
        </div><button className="sidebar-footer" onClick={() => setSettings(true)}><ShieldCheck size={14} /><span>本地执行 · DeepSeek</span></button>
      </aside>}
      <main className="main-panels" ref={center}>
        <section className="chat-panel" style={{ flexBasis: workspace ? `${chatWidth}%` : "100%" }} aria-label="聊天区">
          <div className="panel-header"><Folder size={15} /><span className="panel-title">{chat?.title ?? "新聊天"}</span>{chat && <IconButton label="删除聊天" disabled={deleting || !(["idle", "ended", "stopped", "failed"].includes(chat.execution) && !chat.changes.some(change => ["pending", "needs-reconcile"].includes(change.status)) || chat.error === "CHAT_DELETE_INCOMPLETE")} onClick={() => setDeleteTargetId(chat.id)}><Trash2 size={15} /></IconButton>}<IconButton label="切换工作区" onClick={() => setWorkspace(value => !value)}><PanelRight size={16} /></IconButton></div>
          <div className="conversation">
            {!chat?.messages.length && <div className="welcome"><div className="welcome-symbol"><Code2 size={31} strokeWidth={1.4} /></div><h1>{project ? `一起构建 ${project.name}` : "从一个本地项目开始"}</h1><p>{project ? "理解代码、修复问题，把一个小想法变成可用的功能。" : "让 DeepSeek 理解你的代码，在本机完成编程任务。"}</p>
              {!project ? <button className="primary-button" onClick={() => void chooseProject()} disabled={busy}><FolderOpen size={16} />{busy ? "正在检查项目…" : "选择项目"}</button> : <div className="suggestions">{[["理解这个项目", "介绍这个项目的结构和主要入口，先不要修改文件。"], ["定位一个问题", "帮我定位这个问题的原因，并说明需要怎样验证："], ["实现一个小功能", "我想在这个项目中增加一个小功能："]].map(([title, text]) => <button key={title} onClick={() => { setDrafts(old => ({ ...old, [chat!.id]: text! })); composer.current?.focus(); }}><MessageSquare size={15} /><span>{title}</span><ChevronRight size={14} /></button>)}</div>}
              {project && <div className="project-caption"><Folder size={13} /><span title={project.path}>{project.path}</span></div>}
            </div>}
            {chat?.messages.map(message => <article className={`message ${message.role}`} key={message.id}>{message.role === "assistant" && <div className="message-label">DeepSeek</div>}<div className="markdown">{markdown(message.text)}</div></article>)}
            {chat && chat.tools.length > 0 && <details className="tool-summary" open={!!active}><summary><Terminal size={14} />{chat.tools.length} 项工具操作</summary>{chat.tools.map(tool => <button key={tool.id} onClick={() => { setTab("output"); setWorkspace(true); }}><span className={`tool-dot ${tool.status}`} /><span>{tool.title}</span>{tool.exitCode !== null && <span className="tool-exit">退出 {tool.exitCode}</span>}</button>)}</details>}
            {chat && chat.execution !== "idle" && <div className="task-summary"><span>{executionLabels[chat.execution]}</span><span>{chat.verification === "passed" ? "配置的验证命令通过" : verificationLabels[chat.verification]}</span>{chat.changes.length > 0 && <button className="text-link" onClick={() => { setTab("changes"); setWorkspace(true); }}>{chat.changes.length} 个改动文件</button>}</div>}
            {chat?.verificationCommand && <div className="verification-note">验证位置：隔离副本 · 首次验证退出码 {chat.baselineExit ?? "未知"}<code>{chat.verificationCommand}</code></div>}
            {chat?.error && <div className="inline-error">{errorText(chat.error)}</div>}{chat?.execution === "reconcile" && chat.reviewId && <button className="text-link" disabled={busy} onClick={async () => { setBusy(true); try { const result = await request({ type: "reopen-review", chatId: chat.id }); if (result?.ok) { setTab("changes"); setWorkspace(true); } } finally { setBusy(false); } }}>{busy ? "正在核对…" : "核对并重开审阅"}</button>}
            {chat?.execution === "reconcile" && !chat.reviewId && !chat.changes.length && chat.error !== "CHAT_DELETE_INCOMPLETE" && <button className="text-link" disabled={busy} onClick={async () => { setBusy(true); try { await request({ type: "abandon-isolated", chatId: chat.id }); } finally { setBusy(false); } }}>{busy ? "正在核对…" : "核对并放弃本次隔离尝试"}</button>}
            {chat && ["stopped", "failed"].includes(chat.execution) && <button className="text-link" onClick={() => startChat(chat.projectId)}>新建聊天继续工作</button>}<div ref={bottom} />
          </div>
          <div className="composer-area"><div className="composer"><textarea ref={composer} aria-label="输入任务" placeholder={!project ? "先选择一个本地项目" : !canCompose ? "请先处理待审阅改动或核对状态" : "描述任务，或询问这个项目…"} disabled={!project || !canCompose} value={draft} maxLength={8000} onChange={event => setDrafts(old => ({ ...old, [chat?.id ?? "empty"]: event.target.value }))} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={3} /><div className="composer-toolbar"><select aria-label="任务方式" value={chat?.mode ?? "read"} disabled={!canCompose} onChange={event => { if (chat) void request({ type: "set-mode", chatId: chat.id, mode: event.target.value as Chat["mode"] }); }}><option value="read">只读分析</option><option value="write">修改并验证</option></select><div className="composer-spacer" /><button className="model-picker" onClick={() => setSettings(true)}>DeepSeek Flash <ChevronDown size={12} /></button>{active ? <button className="send-button stop-button" aria-label="停止任务" disabled={chat.execution === "stopping"} onClick={() => void request({ type: "stop", chatId: chat.id })}><Square size={12} fill="currentColor" /></button> : <button className="send-button" aria-label="发送任务" disabled={!state?.executionAvailable || !draft.trim() || !canCompose} title={state?.runtime.ready ? "发送（Enter）；换行（Shift+Enter）" : "先配置模型与执行环境"} onClick={() => void send()}><ArrowUp size={18} /></button>}</div></div><div className="composer-caption">{chat?.mode === "write" ? "在隔离副本中修改，审阅后应用到原项目" : "只读分析不会修改项目文件"}<span>{active ? executionLabels[chat.execution] : state?.budget.configured ? `单任务最多 ¥${state.budget.perTask}` : "请先设置预算"}</span></div></div>
        </section>
        {workspace && <><div className="splitter" role="separator" aria-label="调整聊天与工作区宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={event => { event.preventDefault(); setDragging(true); }} onKeyDown={event => { if (event.key === "ArrowLeft") setChatWidth(value => Math.max(30, value - 2)); if (event.key === "ArrowRight") setChatWidth(value => Math.min(70, value + 2)); }} /><section className="workspace-panel" aria-label="工作区"><div className="workspace-nav"><div className="workspace-tabs">{([['files', '文件', FileText], ['changes', '改动', FileDiff], ['output', '输出', Terminal]] as const).map(([key, label, Icon]) => <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key)}><Icon size={14} />{label}{key === "changes" && !!chat?.changes.length && <small>{chat.changes.length}</small>}</button>)}</div><IconButton label="收起工作区" onClick={() => setWorkspace(false)}><PanelRight size={16} /></IconButton></div>
          {tab === "files" && <><div className="file-tabs">{files.map(file => <div className={`file-tab ${preview?.relative === file.relative ? "active" : ""}`} key={file.relative}><button onClick={() => { setPreview(file); setSourceView(false); }}><FileCode2 size={13} />{file.relative.split("/").at(-1)}</button><IconButton label={`关闭 ${file.relative}`} onClick={() => { const next = files.filter(item => item.relative !== file.relative); setFiles(next); if (preview?.relative === file.relative) setPreview(next.at(-1) ?? null); }}><X size={12} /></IconButton></div>)}</div>
            {preview ? <><div className="file-path"><span>{project?.name} <ChevronRight size={12} /> {preview.relative}</span><button onClick={() => setSourceView(value => !value)}>{sourceView ? "查看预览" : "查看源文本"}</button></div><div className="file-content">{preview.relative.toLowerCase().endsWith(".md") && !sourceView ? <div className="markdown">{markdown(preview.text)}</div> : <pre className="source-view">{preview.text.split("\n").map((line, index) => <div key={index}><span className="line-number">{index + 1}</span><code>{line || " "}</code></div>)}</pre>}</div></> : <div className="file-browser">{project ? <><div className="file-browser-title"><FolderOpen size={16} /><strong>{project.name}</strong><span>{project.files.length} 个文本文件</span></div><div className="file-list">{project.files.map(file => <button key={file} onClick={() => void openFile(file)}><FileText size={15} /><span>{file}</span><ChevronRight size={13} /></button>)}</div><p className="muted-note">{project.excluded > 0 ? `${project.excluded} 个敏感或内部路径已排除。` : "文件预览来自你选择的项目。"}</p></> : <div className="workspace-empty"><FileCode2 size={29} strokeWidth={1.2} /><h2>文件与修改，在这里查看</h2><p>选择项目后预览文件。任务完成后，<br />在这里审阅差异与验证结果。</p></div>}</div>}</>}
          {tab === "changes" && (change ? <div className="review-panel"><div className="review-toolbar"><div><strong>{pendingChanges.length} 个待应用文件</strong><span>相对于本次任务开始时的内容</span></div><button className="primary-button" disabled={!pendingChanges.length || applying || chat?.execution !== "ended"} onClick={() => void applyChanges(pendingChanges.map(change => change.relative))}>{applying ? "正在核对并应用…" : "应用全部"}</button></div><div className="change-list">{chat?.changes.map(item => <button key={item.relative} className={change.relative === item.relative ? "active" : ""} onClick={() => setSelectedChange(item.relative)}><FileDiff size={14} /><span>{item.relative}</span><small>{({ pending: "待应用", applied: "已应用", conflict: "冲突 · 未覆盖", refused: "未应用", "needs-reconcile": "需要核对" })[item.status]}</small></button>)}</div><div className="diff-heading"><span>{change.relative}</span>{change.status === "pending" && <button className="text-link" disabled={applying || chat?.execution !== "ended"} onClick={() => void applyChanges([change.relative])}>应用此文件</button>}</div><div className="diff-columns"><section><header>任务开始时</header><pre>{change.before || "（文件不存在或为空）"}</pre></section><section><header>{change.status === "applied" ? "已应用版本" : "待应用版本"}</header><pre>{change.after || "（删除文件或空内容）"}</pre></section></div><div className="review-footer"><span>应用前再次检查原文件。冲突时保留双方内容。</span>{pendingChanges.length > 0 && <button disabled={applying || chat?.execution !== "ended"} onClick={() => { if (chat?.reviewId) void request({ type: "discard", chatId: chat.id, reviewId: chat.reviewId }); }}>放弃未应用改动</button>}</div></div> : <div className="workspace-empty"><FileDiff size={29} strokeWidth={1.2} /><h2>还没有待应用的改动</h2><p>修改在隔离副本中完成。<br />审阅后，才会写入原项目。</p></div>)}
          {tab === "output" && <div className="output-content">{chat?.tools.length ? chat.tools.map(tool => <details key={tool.id} open><summary><Terminal size={14} />{tool.title}<span>{tool.exitCode === null ? "未确认退出" : `退出 ${tool.exitCode}`}</span></summary><pre>{tool.output || "没有输出"}</pre></details>) : <div className="workspace-empty"><Terminal size={29} strokeWidth={1.2} /><h2>等待执行记录</h2><p>命令、输出和实际退出码会显示在这里。</p></div>}</div>}
        </section></>}
      </main>
    </div>
    {error && <div className="toast" role="alert"><span>{error}</span><IconButton label="关闭提示" onClick={() => setError(null)}><X size={15} /></IconButton></div>}
    {deleteTarget && <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-label="删除聊天"><div className="settings-heading"><h2>删除这个聊天？</h2><IconButton label="取消删除" disabled={deleting} onClick={() => setDeleteTargetId(null)}><X size={18} /></IconButton></div><div className="settings-section"><p>将删除“{deleteTarget.title}”的聊天、工具记录和已结束任务的本机副本。原项目文件、模型密钥和预算记录会保留。</p><p>删除后不能在应用内恢复这些聊天记录。</p><button className="primary-button" disabled={deleting} onClick={async () => { const targetId = deleteTarget.id; setDeleting(true); try { const result = await request({ type: "delete-chat", chatId: targetId }); if (result?.ok) { setDeleteTargetId(null); setDrafts(old => { const next = { ...old }; delete next[targetId]; return next; }); } } finally { setDeleting(false); } }}>{deleting ? "正在删除…" : "删除聊天和副本"}</button></div></section></div>}
    {settings && <div className="modal-backdrop" onClick={() => setSettings(false)}><section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" onClick={event => event.stopPropagation()}><div className="settings-heading"><h2>设置</h2><IconButton label="关闭设置" onClick={() => setSettings(false)}><X size={18} /></IconButton></div><div className="settings-section"><h3>模型与密钥</h3><div className="setting-row"><span>DeepSeek Flash</span><span className="subtle-badge">{state?.runtime.key ? "密钥已加密保存" : "尚未配置密钥"}</span></div><label className="setting-label" htmlFor="api-key">DeepSeek API Key</label><div className="key-field"><input id="api-key" type="password" autoComplete="off" spellCheck={false} placeholder={state?.runtime.key ? "输入新密钥以替换" : "输入 API Key"} value={keyInput} onChange={event => setKeyInput(event.target.value)} /><button disabled={keyBusy || !keyInput.trim() || !!active} onClick={() => void saveKey()}>{keyBusy ? "保存中…" : "保存密钥"}</button></div>{state?.runtime.key && <button className="text-link small" disabled={!!active} onClick={() => void request({ type: "delete-key" })}>删除本机密钥</button>}<div className="connection-check"><button disabled={!state?.runtime.key || checkingConnection || !!active} onClick={() => void checkConnection()}>{checkingConnection ? "正在验证连接…" : "验证模型连接"}</button><span>{connectionVerified ? "模型接口已响应" : "将发起一次计费请求，计入现有预算"}</span></div><p>密钥由 Windows 加密保存，保存后不回传。任务中选择的代码与工具输出会发送至 DeepSeek 官方 API；项目文件和命令在本机处理。</p></div>
      {project && <div className="settings-section"><h3>项目验证 · {project.name}</h3><label className="setting-label" htmlFor="test-command">验证命令（可选）</label><textarea id="test-command" value={testCommand} onChange={event => setTestCommand(event.target.value)} placeholder="填写已准备好的项目测试命令" rows={2} maxLength={2048} /><button className="text-link small" disabled={!!active} onClick={() => void request({ type: "set-test-command", projectId: project.id, command: testCommand })}>保存验证命令</button><p>命令在隔离副本内运行。只有该命令实际执行并返回成功，才标记通过；它不代替人工审阅。未配置时保留实际工具记录，整体状态为尚未验证。</p></div>}
      <BudgetSettings state={state} disabled={!!active || checkingConnection || busy} request={request} /><div className="settings-section"><h3>本地执行环境</h3>{([['engine', 'Codex 0.162.0'], ['shell', 'PowerShell 7.6.5'], ['node', 'Node 24.8.0']] as const).map(([key, label]) => <div className="setting-row" key={key}><span>{label}</span><span className={state?.runtime[key] ? "status-ok" : "status-missing"}>{state?.runtime[key] ? <><Check size={14} />版本校验通过</> : "未找到匹配版本"}</span></div>)}<p>{state?.runtime.bundled ? "运行环境随应用提供并校验；用户项目的依赖仍需提前准备。" : "开发版本使用已验证的本机运行环境。"}</p></div><div className="settings-section"><h3>首版项目范围</h3><p>Windows 小型单包 JS/TS。源码与资源合计 16 MiB，单文件 1 MiB；普通预装依赖合计 64 MiB。暂不支持链接依赖与大型多包项目。</p><div className="setting-row"><span>修改方式</span><span>隔离副本 · 审阅后应用</span></div></div><div className="settings-footer"><span>lcodex {state?.version}</span><span>个人 · 本地使用</span></div></section></div>}
  </div>;
}
