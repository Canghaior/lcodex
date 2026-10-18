# P1：实际引擎的文本链路

日期：2026 年 10 月 19 日；Codex 0.140.0，二进制 SHA256 与 P1_ENVIRONMENT.md 相同。使用独立 CODEX_HOME、中文空格路径、合成 Git 项目，没有改变用户全局配置。

## 观察、修正与结果

1. 宿主受限执行环境首次阻止 app-server 连接本地 HTTP 模拟服务，任务失败且没有模型请求。获准访问本次 loopback 服务后重测通过；不能把宿主限制当成产品沙箱的验证。
2. 默认回退模型配置发出 46,685 字节请求，reasoning 为 null，没有 max_output_tokens，且包含 multi_agent_v1 namespace 工具。未知模型警告真实存在。这个配置没有转发给 DeepSeek。
3. 根据相同版本 ModelInfo 定义建立最小验证模型目录，关闭 multi_agent、apps、plugins、hooks、goals 等，并禁用 shell。新请求 11,894 字节，reasoning.effort=none，没有 namespace 和 shell 工具，模型元数据警告消失。仍包含 update_plan/request_user_input/view_image，不能仅凭关闭 shell 声称没有其他工具。
4. ephemeral 会话的 thread/read(includeTurns=true) 返回 -32600；改用隔离目录内的持久会话后，任务完成状态和文本能由引擎重新读取。未验证进程重启或断线恢复。
5. 实际付费验证通过：app-server 发出请求，经本地预算入口转发到 DeepSeek，收到 response.completed，最终回答 42；thread/read 的任务状态和回答均匹配。主进程退出码 0，无授权请求或工具执行。

## 付费测试的精确范围

本次只验证文本。入口明确移除工具清单并设 tool_choice=none、max_output_tokens=1024、reasoning.effort=none；保留引擎的 instructions、input 历史和角色。原始 SSE 先在内存中确认终态、用量和无工具调用，再转交引擎，因此尚未验证逐 token 的实时端到端延迟。后续工具验证必须单独进行，不能称为标准 provider 无适配直接兼容。

入口只监听 127.0.0.1 随机端口并核对临时随机令牌，最多接受一次请求；禁止并发，关闭引擎 HTTP/流重试，失败后停止转发。真实 API Key 仅在验证父进程内存中；引擎只获得临时本地令牌，不获得真实 Key。保留 input 与工具字段的体积/类型校验和持久预算控制。这里只保护这条已测试的入口，未证明本地任意同用户进程无法绕过。

实际请求输入 1,708、输出 1 token；高峰未缓存保守估算 **0.003424 元**，非真实账单。累计 4 次推理发送：已知用量估算 0.004612 元，首次未知请求完整计入 0.25 元，累计预算占用 **0.254612 元 / 10 元**；无 pending，无超额。

当前 36 项回归测试通过。临时引擎配置、历史与合成 Git 副本在确认退出后清理，首次失败和精简报告保留，真实预算账本不清理。C/D 可用空间本次均超过 5 GiB 阈值。

## 尚未验证

- 角色实际序列为 developer/user/user；DeepSeek 的角色语义差异仍需行为验证，不能仅凭文本回答通过 A4。
- 函数/custom 编辑工具、并行调度、压缩、大上下文、取消、重连、三类代码任务均未通过。
- Windows shell 和沙箱尚未执行；没有已有改动保护或文件恢复结论。P2 入口仍关闭。
- 模型目录的 32,768 context_window 是本次试验的保守配置，非官方最大上下文或产品承诺；基础指令也是本项目自写的验证指令。

## 复现与来源

离线：先 `npm run build:validation`，运行 `node dist/validation/engine-contract-probe.js <固定 codex.exe 绝对路径>`。付费模式另需显式 --live、当日价格核对标志与已有持久账本，凭据隐藏输入；不要把 Key 放命令参数。

参考：[该版本 ModelInfo 定义](https://github.com/openai/codex/blob/rust-v0.140.0/codex-rs/protocol/src/openai_models.rs)、[模型目录配置](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway)、[app-server](https://learn.chatgpt.com/docs/app-server)、[接口要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)。版本目录配置已由实际二进制读取与请求观察验证，不以最新文档替代实测。
