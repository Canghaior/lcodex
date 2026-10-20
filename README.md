# DeepSeek 桌面编程助手

目标是开发一款接入 DeepSeek 的本地桌面编程助手：选择项目后，通过自然语言完成代码阅读、修改和测试，并能查看执行过程与文件差异。

P1 已在用户确认的小型 JS/TS 项目范围内通过。桌面已走通真实 DeepSeek 修复、差异审阅、应用、重启审阅及再次续聊；只读、停止与冲突保护有实际桌面联测。P3 当前范围核心条件已通过，P4 已生成带运行时的 Windows 0.0.1 安装候选。旧 Flash 配置下三类真实任务各三次通过；当前 Pro/high 修复重复验收为 2/3，复杂源码阅读仍失败，完整交付验收尚未完成。证据见 [桌面检查](docs/validation/P2_DESKTOP.md)、[恢复检查](docs/validation/P3_RECOVERY.md)、[分发验证](docs/validation/P4_PACKAGING.md)、[历史真实模型验收](docs/validation/P4_ACCEPTANCE.md)和[思考模式验证](docs/validation/P4_THINKING.md)。首次操作见[候选版使用说明](docs/USER_GUIDE.md)。

- [开发方案](docs/DEVELOPMENT_PLAN.md)：产品范围、技术路线、阶段任务和验收标准。
- [编程执行计划](docs/IMPLEMENTATION_PLAN.md)：P0 至 P4 的开发工作包、执行顺序、检查条件和 GitHub 同步规则。
- [技术架构](docs/ARCHITECTURE.md)：已确认的 TypeScript、React、CSS、Electron 技术栈，分层职责、计划目录与本地 Git 保存规则。
- [界面要求](docs/UI_SPEC.md)：用户指定的 Codex 风格布局、视觉参考与 DeepSeek 模型区域。
- [补充建议评审](docs/PLAN_REVIEW.md)：逐项处理结果、官方资料核对、工作量和待决定事项。
- [执行记录](docs/PROGRESS.md)：当前阶段、下一步、验证证据和决策记录。
- [P1 门槛核对](docs/validation/P1_GATE_REVIEW.md)：已通过的限定样本、剩余阻塞和路线判断；避免将局部成功当作阶段完成。
- [首个可用版本范围](docs/validation/P1_PROJECT_SCOPE.md)：用户确认的 JS/TS 项目、普通依赖、资源和容量边界，以及后续扩展事项。
- [P1 停止与重连](docs/validation/P1_LIFECYCLE.md)：实际三级进程停止、超时、写后断线与真实模型重启续聊。
- [P1 环境与本地通信结果](docs/validation/P1_ENVIRONMENT.md)：固定版本、运行命令、已通过检查与未验证范围。
- [P1 直接 API 结果](docs/validation/P1_RESPONSES.md)：首个失败、两轮合成工具调用复测、用量与预算；不代表引擎兼容通过。
- [P1 引擎文本链路](docs/validation/P1_ENGINE_TEXT.md)：本地模拟与实际 DeepSeek 文本请求、引擎状态回读，以及尚未验证的工具执行范围。
- [P1 Windows 执行边界](docs/validation/P1_WINDOWS.md)：旧版限制、隔离新版本 MXC 样本及待解决问题。
- [P1 引擎工具与停止](docs/validation/P1_ENGINE_TOOLS.md)：实际工具权限、审批拒绝、首次停止失败与针对性修复。
- [P1 真实只读代码任务](docs/validation/P1_READ_TASK.md)：新候选版本的真实工具调用、代码诊断、独立检查及受限范围。
- [P1 数据与文件保护](docs/validation/P1_DATA_AND_PROTECTION.md)：凭据过滤、网络对照、并发覆盖失败与隔离/恢复可行性，含 D01 选项。
- [P1 真实补丁任务](docs/validation/P1_EDIT_TASK.md)：真实模型修复合成 bug、添加小功能及独立验收；明确受限范围。
- [开发约定](AGENTS.md)：后续开发必须遵守的范围和工作流程。
- [文件清理规则](docs/WORKSPACE_HYGIENE.md)：测试与临时数据的保留边界、磁盘检查和安全清理方式。

当前方案为 0.9，优先服务已有本地项目的个人开发者，围绕代码理解、bug 修复和小功能开发。用户已明确 Codex 风格的界面方向，以及 TypeScript、React、CSS、Electron 技术栈和应用分层，模型只接 DeepSeek。首个可用版本采用已验证的原生 Windows、固定 Codex 0.162.0 与 DeepSeek 官方 API；范围外能力继续扩展。

初始方案已保存在本地 Git 的 `main` 分支根提交中；用户已授权同步到 [GitHub 仓库](https://github.com/Canghaior/lcodex)。每个完成并检查的小工作包或阶段提交并推送，不设定时任务；实际同步结果见执行记录。

用户已恢复完整 P4，要求先稳定本机思考任务，再做虚拟机验收。桌面默认 `deepseek-v4-pro` / `high`，版本与价格已按官方资料核对；首次失败见 [思考模式验证](docs/validation/P4_THINKING.md)，本轮命令参数、验证轮次和进程收尾修正见 [稳定性检查](docs/validation/P4_STABILITY.md)。此前三类各三次 9/9 属于 Flash 配置，不当作 Pro 的通过证据。D01 隔离副本修改、审阅后应用及 D02 首版后置一键撤回保持，已验证的安全边界不能因换模型而省略。

## 开发检查

当前验证工程使用 Node.js 24.x（本机验证为 24.8.0），依赖由锁文件固定：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

桌面开发窗口与检查（开发窗口使用固定本机路径，发布版捆绑运行时）：

```powershell
$env:electron_config_cache = 'D:\make-codex\.local\electron-cache'
node node_modules/electron/install.js
npm start
npm run test:desktop
```

桌面状态保存在 `.local/desktop`，自动化测试只使用 `.local/runs` 下的合成项目。不要清理未核对的任务记录；密钥、日志和运行数据不进入 Git。

Windows 构建使用 `npm run package:win`；按[分发验证](docs/validation/P4_PACKAGING.md)准备固定构建输入。候选产物只保存在 `.local/releases`，不随源码上传。`npm run test:package` 检查真实打包程序，模型响应为模拟；`node tests/installer.mjs --install` 会在确认没有已有 lcodex 安装后临时安装并卸载本候选，属于显式安装验收。

`node tests/packaged-live.mjs --live` 为显式计费验收，三类各三次使用新建合成项目，叠加原有开发预算账本；凭据通过隐藏输入提供。真实源码模式 `--kind=real-read` 会发送所选项目片段至 DeepSeek，必须先取得对应数据授权。当前真实源码复测、干净 Windows 和用户实际体验仍待核对，不以小样本通过代替。

本地引擎握手另运行 `npm run validate:offline -- "<codex.exe 绝对路径>"`，需要 P1 环境文档中登记的引擎版本与哈希。此命令不调用模型、不开启编程任务、不验证实际沙箱权限。原始生成文件在 `.local/`，不提交到 GitHub。
