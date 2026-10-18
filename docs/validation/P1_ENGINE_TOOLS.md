# P1：实际 app-server 的权限、拒绝与停止

日期：2026 年 10 月 19 日。使用隔离的 Codex 0.162.0（哈希见 P1_WINDOWS.md）、MXC、PowerShell 7.6.5 与合成 Git 目录。模型响应由本地服务预先构造，**真实执行引擎与命令，但不调用真实模型**，费用 0。

## 接口与配置差异

从本次二进制生成 schema，未沿用旧版猜测字段。实际工具为 exec_command/write_stdin，而非旧版 shell_command；即使目录元数据声明不并行，实际请求仍含 parallel_tool_calls=true，后续须在调度/响应入口落实上限。新版本将基础指令放入 developer 消息，实际序列为 developer/developer/user/user；不再看到旧版 instructions 字段，角色行为仍需 DeepSeek 验证。

命名权限配置设为 scoped，启动 thread 时不再传覆盖它的通用 sandbox 值。scope 包含项目、必要系统与固定 shell 运行时路径，.env 明确 deny、.git 为 read；没有向用户其他文件授权。第一次执行因漏列 shell 目录而失败，补上已核验的运行时目录后才通过，不把启动失败记作保护成功。

## 实际结果

| 样本 | 断言和结果 |
| --- | --- |
| 只读任务 | 项目内读取成功；外部和 .env 读取失败；写标记失败，父进程确认标记不存在；工具结果按 call_id 回传，任务 completed 且 thread/read 回读一致 |
| 可写任务 | 项目内读取与标记写入成功；外部和 .env 读取仍失败；父进程确认标记存在；任务和历史回读一致 |
| 拒绝授权 | on-request + approvalsReviewer=user；固定工具请求 require_escalated，客户端按该版 schema 回复 decision=decline；收到一次审批请求，工具结果报告 rejected by user，标记不存在；没有授予权限 |
| 首次停止 | 单独 turn/interrupt 已产生 interrupted，但固定命令仍继续运行并在 8 秒后写标记，**失败** |
| 停止修复复测 | 先阻止入口新请求，再 turn/interrupt、thread/backgroundTerminals/clean，轮询 list 至空，核对已知 OS PID 结束；等待超过延迟写入时间后标记仍不存在，线程 interrupted 回读一致，**该样本通过** |

停止复测使用 capabilities.experimentalApi=true，并核对生成的实验接口 schema。clean 返回后列表不是立即为空，第一次同步判断仍失败；改为“正在停止”期间有界等待后，终端数量由 1 变 0。只发送一次中断/清理，轮询是只读查询，没有重放命令。状态不能仅以 turn/completed 或 clean 的 RPC 返回为依据。

该停止样本的命令预先限定 8 秒结束，只作用于自有标记。失败试验也等待其结束再清理；没有用未知 PID 杀进程。任意后台程序、进程树、重连和外部影响仍不在本次通过范围。实验接口属于后续版本固定与回归检查点，不改变主引擎选择。

## 可追溯 schema SHA256

| 文件 | 哈希 |
| --- | --- |
| v2/ThreadStartParams.json | e9c6d3cc18d049bfbc0249add3808fb8e5a27e1a0b5a423767aafbc3859a9428 |
| v2/TurnStartParams.json | 583aff13e7a2da43fbb0150e0edc3c73171f374f0aa745dddba256166988a005 |
| v2/ThreadReadParams.json | dfe040c6ac71d30795b8be3f3ff232e66f362a37f883b491e5d1ea367f470db4 |
| v2/TurnInterruptParams.json | 6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b |
| CommandExecutionRequestApprovalResponse.json | 6d0767113e22f311381809b6b236b0dde2b99b01992879c26bf7b1ea0e003cb7 |
| experimental v2/ThreadBackgroundTerminalsCleanParams.json | e07820971c6e4ef8ee1ca5565a6eb78b04a96e001a5828e136b8aca927096a51 |
| experimental v2/ThreadBackgroundTerminalsListResponse.json | b56b1cbcb1d60079ee9f9caaeef29cad869a25b4a6d356566f7c9f672faa7bf4 |

## 检查与剩余门槛

- 类型检查与构建通过；完整回归 37/37 通过，包括明确拒绝与未知请求拒绝的行为检查。
- 四种实际引擎样本由 `engine-contract-probe` 的 --tool-case=readonly/write/deny/interrupt 复现；需固定二进制及 --shell=绝对路径。付费与这些固定工具样本禁止混用。
- 生成 schema 首次从错误的 v2 子路径读取审批文件而失败，后来定位到根目录并保存哈希；约 7.60 MiB schema 已按归属和无链接检查清理。运行副本、合成 Git 与标记均已清理，精简失败/复测证据保留。
- 仍需真实 DeepSeek 的新版本协议、模型代码任务、实际编辑工具、并行/限额、网络与数据出口、已有改动和并发保护、恢复可行性、重连。MXC 临时目录警告未解决。P1 尚未通过，不进入 P2。

接口语义依据：[app-server 官方文档](https://learn.chatgpt.com/docs/app-server)，实际可用性和以上结论以固定版本的 schema、工具输出、进程与文件观察为准。

## 后续补充：实际 apply_patch 边界

同日补充固定补丁样本，仍使用模拟模型、真实工具。按 0.162.0 的 ModelInfo 将 apply_patch_tool_type 设为 freeform，实际注册 custom 类型 apply_patch；工具结果为 custom_tool_call_output，通过 call_id 关联。

- 只读项目：补丁被权限/审批策略拒绝，原文件不变。
- 可写项目：inside.txt 修改成功，其他文件不变，收到 file change 生命周期和 turn/diff/updated。
- 可写项目中的 .env：读取阶段被拒绝，文件不变。
- 项目外的合成文件：读取阶段被拒绝，文件不变。

可写样本首次和第一次复测均出现“任务成功、引擎退出超时”：原来 3 秒以及改为 10 秒的退出窗口均触发兜底结束，不能算该次完整探针通过。随后查阅固定源码 [thread_processor.rs](https://raw.githubusercontent.com/openai/codex/rust-v0.162.0/codex-rs/app-server/src/request_processors/thread_processor.rs)，正常关闭依次包含各最多 10 秒的后台任务与线程收尾，因此将窗口设为 25 秒，并分别记录任务结果、退出码、耗时、是否兜底结束。

之后一轮可写复测通过，实际正常退出仅 27 毫秒，无强制结束。由于它没有经历长等待，**不能据此确认先前间歇性退出问题的根因已解决**；后续写任务仍须记录和核对退出，超时不能假报正常。通过进程查询确认本项目候选引擎无遗留后，清理两个失败副本共 6,804,784 字节；报告和预算账本保留。

本节点尚未生成真实模型补丁，当时付费入口拒绝 custom 工具和相应历史。后续在专用输入、流式合同与独立验收控制补齐后完成了一个受限真实样本，见 [真实补丁任务](P1_EDIT_TASK.md)；没有放开任意工具。

## 后续补充：退出后重启与历史核对

使用 --edit-task --resume-check，由固定模拟模型形成并实际应用补丁。第一进程结束后，第二进程复用同一私有引擎数据目录，执行 thread/resume 与 thread/read，不发起新 turn。入口已经停止新模型调用，原文件前后哈希另行核对。

首次试验失败：第二进程未在 25 秒内正常退出，触发兜底结束，整体不通过。补充历史、错误码和退出阶段的诊断后复测：同一 thread/turn、completed 状态及回答记录匹配；没有 turn/started、item/started、工具输出事件，没有额外模型请求，文件哈希不变；两个进程正常退出。诊断变更不构成退出问题的修复，间歇性问题仍在，不能仅凭这一轮成功放行稳定性。

退出诊断最终仅保留固定事件标签和计数，不记录原始日志行。日志出现远程控制组件的退出信息，不等于观察到实际外联，也不能据此认定它是卡住的原因；未更改全局配置或启用远程控制。该组件及长上下文/异常中断恢复仍需后续核对。

确认候选引擎无遗留进程后，首次失败副本清理 3,472,034 字节。报告保留，无 API 消耗。此结果覆盖正常完成任务后的一个重启样本，不覆盖写入途中崩溃、多轮继续或所有恢复场景。

## 后续补充：停止命令后重启

使用 --tool-case=interrupt --resume-check --diagnose-exit 串联原有停止检查与重启检查。实际 PowerShell 命令先写启动 PID，等待 8 秒才会写完成标记；协调程序停止入口、interrupt、清理终端，核对终端由 1 变 0、PID 已结束，等待 8.5 秒后仍没有完成标记。

第一进程与历史均为 interrupted，正常退出 36 毫秒。第二进程恢复同一 thread/turn，历史仍为 interrupted；未出现 turn/started、item/started 或工具输出重放事件，无新增模型请求，文件哈希不变，第二进程退出码 0。固定命令是模拟模型请求，真实 OS 执行；没有付费消耗。

重启检查现按明确的 completed/interrupted 期望分别核对，不再要求中断任务必须有最终回答才能通过。这个结果不覆盖电源中断、写入途中的未知结果或任意进程树，也不解决之前间歇性退出问题。相关运行副本均已清理。
