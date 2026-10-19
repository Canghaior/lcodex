# DeepSeek 桌面编程助手

目标是开发一款接入 DeepSeek 的本地桌面编程助手：选择项目后，通过自然语言完成代码阅读、修改和测试，并能查看执行过程与文件差异。

已进入 P1，TypeScript 验证工程已跑通受限的 DeepSeek 读代码、补丁修改、沙箱测试与总结闭环。完整兼容性和文件保护尚未通过；还没有桌面应用或安装包。

- [开发方案](docs/DEVELOPMENT_PLAN.md)：产品范围、技术路线、阶段任务和验收标准。
- [编程执行计划](docs/IMPLEMENTATION_PLAN.md)：P0 至 P4 的开发工作包、执行顺序、检查条件和 GitHub 同步规则。
- [技术架构](docs/ARCHITECTURE.md)：已确认的 TypeScript、React、CSS、Electron 技术栈，分层职责、计划目录与本地 Git 保存规则。
- [界面要求](docs/UI_SPEC.md)：用户指定的 Codex 风格布局、视觉参考与 DeepSeek 模型区域。
- [补充建议评审](docs/PLAN_REVIEW.md)：逐项处理结果、官方资料核对、工作量和待决定事项。
- [执行记录](docs/PROGRESS.md)：当前阶段、下一步、验证证据和决策记录。
- [P1 门槛核对](docs/validation/P1_GATE_REVIEW.md)：已通过的限定样本、剩余阻塞和路线判断；避免将局部成功当作阶段完成。
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

当前方案为 0.5，优先服务已有本地项目的个人开发者，围绕代码理解、bug 修复和小功能开发。用户已明确 Codex 风格的界面方向，以及 TypeScript、React、CSS、Electron 技术栈和应用分层，模型只接 DeepSeek。首发 Windows 与官方 API 接入方式仍沿用方案安排；具体依赖版本、引擎兼容性和支持项目类型由 P1 确定。

初始方案已保存在本地 Git 的 `main` 分支根提交中；用户已授权同步到 [GitHub 仓库](https://github.com/Canghaior/lcodex)。每个完成并检查的小工作包或阶段提交并推送，不设定时任务；实际同步结果见执行记录。当前只有验证程序，桌面应用工程尚未创建。

下一步是 P1 技术验证，分别验证协议、模型任务能力与 Windows 本地执行；文件保护、停止与权限门槛通过后再开放桌面端真实写入。D01 已确认隔离副本修改、审阅后应用；D02 已确认首版后置一键撤回，保留基线、差异与冲突保护。

## 开发检查

当前验证工程使用 Node.js 24.x（本机验证为 24.8.0），依赖由锁文件固定：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

本地引擎握手另运行 `npm run validate:offline -- "<codex.exe 绝对路径>"`，需要 P1 环境文档中登记的引擎版本与哈希。此命令不调用模型、不开启编程任务、不验证实际沙箱权限。原始生成文件在 `.local/`，不提交到 GitHub。
