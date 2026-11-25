# P4-OA：OpenAI GPT-6.2 Astra 接入

日期：2026-11-25。对应 F02/F08/F09，按用户最新要求增加 OpenAI，保留 DeepSeek。用户选择自己的 API Key，并另行授权本次真实测试最多 5 美元；不挪用原 DeepSeek 人民币预算。

## 固定配置与边界

- 官方端点 `https://api.openai.com/v1/responses`，模型 `gpt-6.2-astra`，思考 `high`，输出上限 8192 tokens，`store:false`。输入仍限制 96 KiB，原请求/工具/时间限制与隔离保护保持。
- OpenAI 原生保留 developer 角色、工具关联及最终 encrypted reasoning；当前边界指令通过 instructions 传递。DeepSeek 保留既有角色映射，不共享厂商历史。
- 新聊天可选择厂商，发送后固定；旧聊天默认 DeepSeek。重启时核对聊天、task/outcome 和索引中的模型身份。两家共用全局单任务限制。
- Windows safeStorage 分别保存 `deepseek.bin` / `openai.bin`。前端密钥、价格和预算命令显式绑定厂商，过时目标拒绝；旧 IPC 仅指向 DeepSeek。状态 revision 拒绝过时回包，连接检查结果绑定厂商。
- OpenAI 使用独立 `openai-usage-usd.jsonl`，version 3 显式标记 USD；旧 CNY 账本 version 1/2 不迁移、不换算、不清零。保存 Key 不调用 API，连接验证计入预算。
- 标准档输入 8 美元/百万 tokens、输出 40 美元/百万 tokens；思考包含于输出，不重复计费。固定 `service_tier:default`，显式缓存模式不设断点，避免额外缓存写入费；意外缓存写入用量保留预留并停止。请求前按 UTF-8 大小、协议余量、加密思考回放上界及完整输出上限预留，预算不够不发请求；未知用量阻止下一次调用。

官方依据：[模型与价格](https://developers.openai.com/api/docs/models/gpt-6.2-astra)、[6.2 请求语义](https://developers.openai.com/api/docs/guides/latest-model)、[加密思考](https://developers.openai.com/api/docs/guides/reasoning)、[缓存模式](https://developers.openai.com/api/docs/guides/prompt-caching)。官方 [Python SDK reasoning 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_reasoning_item.py) 允许 content 缺省/None；本地按无 raw reasoning 事件时的 null 兼容，不宣称线上一定返回 null。

## 首次失败与修复

1. 初次全回归 117 项中 103 通过、13 失败、1 取消。原生 Windows 用例引用的全局 Codex PowerShell 缓存已升级，SHA-256 从固定 `362a356c…` 变成 `2a6769a3…`，被原哈希检查拦截。未改用户全局缓存，未放宽保护；从旧候选逐文件核对 658 个运行时 manifest 项后保存到项目 `.local/engines/powershell-7.6.5`。开发、打包及回归夹具统一选择该固定目录，仍经过原哈希检查。只调整测试运行时定位，未修改独立项目验收器或原断言。
2. 首次 OpenAI 桌面夹具在异步等待尚未获得终态时断言 running/ended 失败；改为按快照显式轮询，保留首次记录。复测实际 app-server/MXC 工具、初始测试失败、补丁、复测、审阅、重启与继续聊天通过。模型响应为模拟，实际命令和文件操作真实执行。
3. 存储专项初次误用尚未重新编译的桌面产物；重新构建后 44 项模型/预算/存储专项通过。
4. DeepSeek 桌面首轮 1/5 通过：预算标题变化导致旧精确定位失败；旧夹具依赖 10 月的默认价格确认，当前日期阻止发送。保留原预算标题，在其下独立展示厂商/币种；模拟夹具增加正常的当日价格确认。未关闭产品每日价格检查，也未更改模型响应或独立验收断言。
5. 静态审查发现跨聊天延迟回包可能使密钥操作使用错误当前厂商，已用显式 provider、快照 revision、预览完成后取状态和连接结果绑定修复。补充拒答文本 SSE/历史与 nullable reasoning 的协议回归；拒答经实际 app-server 的展示尚未单独验收。

## 验证与剩余事项

OpenAI 实际引擎模拟联测通过：独立加密密钥及美元账本、错厂商 IPC 拒绝、全局任务互斥、真实修改/测试/冻结审阅、重启后零请求重开审阅、应用后保留最终加密思考继续聊天。原项目在审阅前字节保持，DeepSeek 密钥与账本字节保持。

最新类型检查与构建通过；完整组件回归 118/118、存储/预算/删除回归 7/7 通过。首次候选打包含 2918 个运行时文件、45 个应用文件。桌面回归 6/6（DeepSeek 与 OpenAI），最终成品在工作盘配置、无开发 PATH 下的读取/测试/审阅/重启 1/1 通过；未重跑或宣称 AppData 原阻塞已修复。不把官方资料、模拟响应或界面可打开等同于真实 Astra 可用性。原 AppData 下 cmd/npm 超时、复杂源码成功率、最终安装与干净 Windows 验收仍保留为 P4 未完成项。

本轮已结束失败副本的定向清理命令被自动审批策略阻止，未提供具体原因，保留副本没有继续尝试删除。已检查 C/D 剩余空间充足，运行目录约 237 MiB；未清理个人账本或用户数据。

## 用户自己的 Key：真实 API 结果

用户在本机设置界面输入并加密保存 Key，调用期间未读取或输出明文 Key。额度从独立 OpenAI 账本控制，累计上限 5 美元，未重置旧账本。实际调用官方 Astra API，未替换 fetch 或模型响应：

1. 连接验证成功，估算 0.000368 美元。
2. 合成单包 JS 数量计算任务：实际读取、首次测试退出 1、修复 catalog.mjs、复测 passed，共 5 项工具；仅该文件有待应用差异。审阅前原项目保持，受控应用后独立空数组、数量乘法及零数量检查通过；测试文件未被修改。连接加修复累计 0.207216 美元。
3. 最终成品重启后继续原聊天，Astra 结合历史重新读取 catalog.mjs，任务正常结束，用户消息累计 2 轮、工具累计 6 项，已修复源文件字节不变。说明真实多轮加密思考与重启历史在该小样本可用。

本轮共 9 次真实请求，全部返回用量并结算；保守估算累计 **0.310360 美元**，pending=0、unknown=0，剩余累计上限 4.689640 美元。未查询实际账单。这是连接、小型修复与只读续聊样本，不代表复杂仓库或一般任务成功率。DeepSeek 原累计预算记录未变。

最终本地候选 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| lcodex.exe | `676a571278c131b1c98af14df627dc20f132918c09edf0bc1604091567fe7fc3` |
| resources/app.asar | `2d0a1c5c7e7a9965202ef4fbcfcfc91a48275d9d42c178ea61826f45edd16cd5` |
| lcodex-0.0.1-win-x64-setup.exe | `fb3c511f0cdf7d7dc5d252687f4a62f5169bbf0faafff077b456ee86a33cd99a` |

源码与证据随 GitHub 保存，安装包、个人配置、预算、Key 及原始运行记录不提交。根目录 start-lcodex.cmd 打开本地成品并明确使用 .local/desktop 配置，便于复用本次保存的 Key；直接双击 exe 则使用其默认 AppData 配置，二者不会自动搬迁数据。
