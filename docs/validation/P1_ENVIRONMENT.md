# P1 首轮环境与本地通信验证

日期：2026 年 10 月 19 日（Asia/Shanghai）。范围：P1-01 与 P1-02 的环境、schema、本地握手部分。尚未通过 P1 总体验收。

## 版本与配置

| 项目 | 实际观察 | 结论边界 |
| --- | --- | --- |
| 操作系统 | win32 / x64，构建 26200.9711，DisplayVersion 25H2 | 注册表 ProductName 返回 Windows 10 Home China，名称与构建信息需区分；CIM 查询被环境拒绝，系统版本名称未进一步确认 |
| 本轮宿主 shell | PowerShell Core 7.6.5 | 来自开发工具环境；不代表最终安装包可以依赖这份宿主运行时，应用所用 shell 待执行试验固定 |
| Node.js / npm | 24.8.0 / 11.6.0 | 本轮验证工程使用，未升级系统工具 |
| Git | 2.45.1.windows.1 | 已有本地与 GitHub 工作流 |
| TypeScript / Node 类型 | 5.9.3 / @types/node 24.8.1 | 项目内安装，直接版本固定，传递依赖由 package-lock.json 固定；安装时禁用生命周期脚本 |
| 首轮引擎 | codex-cli 0.140.0，已有官方 npm 包中的 Windows x64 原生可执行文件 | 只冻结本轮离线试验；不代表该版本已满足产品要求，不升级用户全局 Codex |
| 引擎 SHA-256 | `03e5cf467f4ef2c06360b00cdc9aef64bb79b2028e25e3e122dd0bd2152ace22` | 验证程序同时检查文件哈希和版本，改变版本需要重新核对接口 |
| 本地协议 | stdio / JSONL，initialize → initialized → config/read | schema 由同一原生可执行文件生成；未创建 thread 或 turn |
| 模型配置 | offline_probe，URL 为本机环回不可用端口 | 没有 DeepSeek 或 OpenAI 推理请求，不使用任何真实 API Key |
| 配置隔离 | 每次运行在 .local 下新建含中文与空格的目录；子进程使用独立 home/profile/temp | 核对 initialize 返回的 codexHome；未修改用户现有 Codex 配置或账号 |
| 执行策略 | 配置读取确认 read-only / never | 仅证明配置值有效，未证明文件权限、沙箱或命令执行边界生效 |
| 模型与费用 | 实际模型未固定；用户已授权 P1 总计 10 元、每次试验最多 1 元 | 本轮模型请求 0、模型费用 0；计量与停止控制还未实现，不启动付费任务 |

子进程环境按允许清单建立，不继承模型密钥、登录 token、用户代理凭据或 NODE_OPTIONS。配置中的模型地址和子进程代理指向本机环回地址，避免离线握手误用真实服务；这不是操作系统级网络隔离的通过证明。

## 运行结果

运行命令与适用范围：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run validate:offline -- "<本机固定版本 codex.exe 的绝对路径>"
```

最后一条须替换占位路径，或在本机设置 CODEX_BINARY 后运行 `npm run validate:offline`。程序只接受已登记版本和哈希；不通过 shell 调用 .cmd/.ps1 包装器。

| 检查 | 结果 | 证据或范围 |
| --- | --- | --- |
| 类型检查 | 通过 | npm run check |
| 通信与环境测试 | 12/12 通过 | npm test：UTF-8 分片、乱序关联、通知、服务器请求拒绝、错误脱敏、畸形和超长数据、断线、超时无重试、环境白名单 |
| 同版本 schema 生成 | 通过 | 运行时生成在忽略的 .local 目录；四份相关 schema 的 SHA-256 见 offline-report.json |
| 原生引擎初始化 | 通过 | 返回 Windows 平台及独立 codexHome，未创建聊天任务 |
| 配置读取 | 通过 | 确认离线 provider、read-only 和 never |
| 中文和空格路径 | 部分通过 | 此路径中的配置、schema 和握手可用；未执行项目搜索、编辑或 shell，不算 C1 整项通过 |
| 进程退出 | 通过本轮场景 | stdin 关闭后主进程退出码 0，无强制终止；没有工具子进程，不算 C3 整项通过 |
| 真实 DeepSeek 协议、三类任务、Windows 沙箱、文件保护 | 未验证 | 不以握手、配置值或模拟通信结果替代 |

脱敏运行结果见 [offline-report.json](offline-report.json)。报告只保留版本、哈希、布尔状态、计数和退出码；不保存完整引擎响应、stderr 文本或本机用户名路径。

首次类型检查发现计时器类型冲突：先移除不适用于 Node 验证程序的默认 DOM 类型，再修正定时回调参数。随后类型检查、12 项测试和真实本地引擎握手通过。首个环境查询中的 CIM 拒绝未被当作操作系统验证成功；未修改系统权限来规避。

## 官方资料复核

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)：核对逐行 JSON、初始化顺序及版本对应 schema。实现字段另以本轮生成文件核对，未直接照搬最新文档的所有接口。
- [Windows 沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox)：当前资料的 MXC 命令示例注明 CLI 0.162.0 起；本轮 0.140.0 未运行该示例。沙箱方式仍需独立选择与实测，不能据 OS 构建号自动认定可用。
- [DeepSeek Responses 指南](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)：本轮已成功读取正文，补上之前仅搜索索引可用的证据。文档说明无状态历史、developer 视同 user、忽略 parallel_tool_calls 与 max_tool_calls、custom 工具仅支持 apply_patch；这些是 P1 A2 至 A5 的验证输入，尚非项目兼容结果。

## 下一步与未满足门槛

1. 建立可重复的小型 JS/TS 任务样本、Git 脏状态与非 Git 基线，以及独立验收器的完整性记录。用户没有语言偏好，按既定样本启动，不据此声称仅支持 JS/TS 或支持所有语言。
2. 选择真实 DeepSeek 模型并复核价格；建立跨试验的持久用量账本、在途预留、请求与工具限额、超时及失败停止。未知用量不能当成零，10 元与单次 1 元的约束落实后才发送真实请求。
3. 验证 Windows 实际执行和沙箱控制点，并查明引擎的请求计数、串行工具与写入保护能力。控制点不足时保留阻塞，不能开放真实项目写入。
4. 完成 A/B/C 矩阵，再提供 D01/D02 及必要的路线决策材料。P2 至 P4 尚未开始。
