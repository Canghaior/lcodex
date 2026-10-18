# P1：Windows 执行边界的实测

日期：2026 年 10 月 19 日。仅执行预先写定的无害命令，目标全部为 .local/runs 中的合成文件，模型调用 0，没有用户项目写入或管理员安装。

## 固定环境

- 主机 Windows 构建 26200.9711；PowerShell 7.6.5，沙箱内实际报告 ConstrainedLanguage。
- shell SHA256：`362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139`。当前 shell 来自宿主工具运行时，不等于产品已确定可分发依赖。
- 旧引擎：已安装的 0.140.0，哈希见 P1_ENVIRONMENT.md；测试后未替换、升级或修改其全局配置。
- 新候选：官方 npm `@openai/codex@0.162.0-win32-x64`，下载后与 registry 返回的 SHA512 integrity 匹配。原压缩包 165,147,932 字节，解包声明 458,511,688 字节；只提取主程序、command runner、rg 和元数据，未提取语音、code-mode 或管理员 setup 程序。
- 新 codex.exe SHA256：`dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f`；本机执行 --version 返回 codex-cli 0.162.0。0.140 的 --permissions-profile 在 0.162 改为 --permission-profile，已按实际 help 核对。

## 首次失败与修复

最初 CLI 未提供必须的命名权限配置，启动退出 2，未计为权限通过。补配置后，测试中的 .NET 文件方法受 PowerShell 语言模式限制，最初的读取/写入失败仍不能作为文件权限证据。改用 Get-Content/Set-Content 并使用 UTF-16 编码参数后，重新执行所有读写断言，保留之前的失败报告。

0.140.0 的 unelevated + :read-only：命令能启动、项目能读、内外写入被拒绝，但项目外文件仍可读，不满足项目读取边界。改为显式 scoped 读取后，后端直接拒绝启动，提示需要 elevated 后端；没有自动降级或安装管理员沙箱。

基于这项证据在项目私有目录评估 0.162.0 + 显式 mxc，不改变主要引擎路线，也不把新版本自动定为最终发布版本。

## 0.162.0 + MXC 结果

权限配置允许最小系统运行依赖与指定 shell 路径，项目按任务方式设 read/write；项目 .env 明确 deny、.git 明确 read；外部目录不授权。所有路径均有中文和空格，链接目标也是本次生成的合成目录。

| 检查 | 只读样本 | 可写样本 |
| --- | --- | --- |
| shell 启动及项目文件读取 | 通过 | 通过 |
| 项目文件写入 | 拒绝，父进程确认无文件产生 | 允许，父进程确认标记文件产生 |
| 项目外读取/写入 | 均拒绝 | 均拒绝 |
| 明确禁止的 .env 读取 | 拒绝 | 拒绝 |
| junction 指向项目外后读取 | 拒绝 | 拒绝 |
| .git/index 写入 | 拒绝，合成基线保持 | 拒绝，合成基线保持 |
| 前台命令退出时子进程结束 | 不适用 | 通过本次有界样本 |

子进程试验使用隐藏窗口启动固定 PowerShell 脚本，先写启动标记，4 秒后拟写完成标记；前台等待 1 秒确认启动并返回 PID。父进程检查该 PID 已不存在，再等待 4.5 秒确认完成标记未产生。子脚本即使未被终止也会自行在 4 秒后退出。此结论只覆盖 CLI 前台退出，不等于 app-server 的 turn/interrupt、断线或任意进程树停止通过。

## 保留问题及证据边界

- MXC 下 PowerShell 每次启动出现隔离 profile 的 AC/Temp 目录警告，退出码与实际读写断言正常；原因及正常临时文件使用仍待核对，不能忽略后宣布环境完全可用。
- CLI 的成功不能转移给 app-server：新版本的 schema、命名权限配置、实际编辑工具及 DeepSeek 协议需重新验证。
- .git/index 是合成保护标记，不是完整 Git 脏工作区保护验收；没有并发编辑、文件恢复、命令审批拒绝或敏感内容模型发送链路的结论。
- 最小运行依赖路径可读是明确例外，不宣称只读取项目的每一个字节；产品需说明运行时例外并禁止扩大到用户其他资料。
- 所有已结束副本已清理，先校验 junction 目标并删除链接本身，再执行安全目录清理；没有 timeout 或待核对运行遗留。

## 磁盘与来源

候选运行时暂保留在 .local/engines/codex-0.162.0，逻辑占用约 331 MiB，用于后续验证，不进入 Git。校验并提取后已删除 165,147,932 字节压缩包及 17,754,338 字节项目 npm 缓存。未删除用户已有 Codex、活跃项目依赖或预算账本。

来源：[0.140.0 配置 schema](https://github.com/openai/codex/blob/rust-v0.140.0/codex-rs/core/config.schema.json)、[Windows 沙箱及 MXC 版本要求](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[命名权限配置](https://learn.chatgpt.com/docs/permissions)、[官方候选包元数据](https://registry.npmjs.org/@openai/codex/0.162.0-win32-x64)。文档能力不替代上述逐项实测。
