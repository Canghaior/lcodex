# P2 桌面工程检查

2026 年 10 月 20 日，P2-01，F01/F03/F04/F10。P1 已在用户确认的 D05 范围内通过；本记录只列桌面集成证据，不替代后续真实任务与安装包验收。

## 当前交付

Electron main、sandbox preload、React renderer、shared 已建立。实际窗口包含窄导航、项目与聊天侧栏、中间对话和输入区、右侧文件/改动/输出区域；支持分栏键盘/拖动调整、折叠、窄窗口、Markdown 与源文本切换。未接通的发送按钮暂时禁用并标注执行接入中，不提供虚假任务结果。

项目由系统目录选择框授权；后台复用 WindowsFileGuard 捕获允许的文本文件。预览只接受该项目清单中的相对路径，重新检查后返回；隐藏敏感路径、拒绝越界和不支持的文件范围。项目、聊天列表与任务方式保存在本机，重启保留。输入草稿目前仅保留于当前窗口，不承诺跨重启恢复。

界面无 Node / require，contextIsolation、进程 sandbox 和 webSecurity 开启。IPC 校验主窗口、主 frame、应用 origin 和精确请求字段；无任意 shell / 文件接口。应用使用专用协议加载本地静态文件，导航、弹窗和额外浏览器权限拒绝；模型 Markdown 不执行 HTML、不加载远程图片。密钥和真实执行尚未接入。

## 依赖与检查

- 固定 npm registry 返回版本：Electron 44.9.0、React / React DOM 19.3.1、Vite 8.3.4、TypeScript 5.9.3、Playwright Core 1.64.1；锁文件保存。安装后 npm audit 报 0 个已知漏洞，这是当时的依赖检查，不代表没有漏洞。
- `npm run check`、`npm run build` 通过。Vite 对 lucide-react 的两条 use client 指令提示仍保留；应用全在客户端，无 React Server Components，构建和运行通过，不据此关闭其他警告。
- `node --test tests/desktop.test.mjs`：实际 Electron 窗口测试通过，覆盖选择中文空格路径合成项目、文件预览、敏感文件排除、HTML/外链图片不执行、越界读取与未知 IPC 拒绝、聊天切换保留草稿、模式保存、分栏、窄窗口、125% 应用缩放与重启后的列表。
- 共享 guard 仅补可信脚本目录参数，脱离启动 cwd；随后原生完整回归 83/83，无跳过。
- 首次缩放截图使用 Playwright 截图时出现裁切；原生 capturePage 与实际 DOM/控件边界复查通过，测试改用实际窗口捕获。该检查是应用缩放，不冒充所有 Windows 显示 DPI 的验收。
- 对照图只含合成项目，保存在被忽略的 `.local/reports/desktop-wide.png` 与 `desktop-narrow.png`；界面已人工查看，最终视觉认可仍由用户实际体验决定。
- 测试没有模型请求，也没有原项目写入；结束后相关 Electron 进程关闭，合成运行目录清理。开发依赖保留一份，Electron 二进制约 368.5 MiB。
- 首次 Electron 下载的环境变量名与新版安装器不符，下载缓存落到了默认用户缓存；没有越界清理全局缓存。后续命令已改为安装器实际读取的 electron_config_cache，明确指定 D 盘项目缓存；活跃二进制仍在 D 盘 node_modules。

## 下一步

P2-02/03：本机密钥保护、真实引擎连接、只读和修改任务、工具事件、停止、差异与受控应用。继续同一累计 10 元 / 单次 1 元开发预算，不因新界面重置。运行时暂使用本机已验证的固定路径，P4 必须补独立分发和干净环境验收。

参考：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[Preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)、[React 版本](https://react.dev/versions)、[Vite](https://vite.dev/guide/)。2026-10-20 核对；实际依赖以 package-lock.json 和运行记录为准。
