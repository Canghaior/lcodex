# P4 干净 Windows 环境检查

2026-10-20；这是只读环境调查与后续验收安排，不是干净 Windows 验收通过。

## 本机实际情况

- 用户要求重新检查后，在自定义安装位置找到 VMware Workstation 17.0.0 build-20800274，包含 vmware、vmplayer 和 vmrun。此前只按常见路径与 PATH 查询而写成“没有 VMware 工具”，结论不完整，本次纠正。
- VMware 授权服务已在运行，NAT/DHCP 服务停止；没有发现运行中的 VMware/VirtualBox/Hyper-V 虚拟机进程。未启动、停止或修改这些已有服务。
- 常见 VMware 用户登记文件、hostd 清单、默认虚拟机目录及 VMware 安装目录中未发现 Windows 虚拟机配置。用户随后打开 Workstation Pro 17，提供的截图显示左侧库中仅有“我的计算机”，未列出虚拟机。没有全盘扫描或打开用户虚拟磁盘，不能据此断言其他位置没有旧虚拟机。
- 本机为 Windows 11 家庭中文版 25H2，约 32 GB 内存，固件虚拟化已开启，系统报告存在 hypervisor。Virtual Machine Platform 已启用，Windows Hypervisor Platform 未启用；没有 Windows Sandbox 或完整 Hyper-V 管理入口。
- 本轮检查只读取软件版本、服务/功能状态和相关配置是否存在，没有安装软件、下载系统镜像、启用功能、改网络、升级 VMware、修改安全设置或重启。
- 用户下载目录中未找到 ISO；VMware 自带 `windows.iso` 的 ISO 卷标实际为 `VMware Tools`，大小 130603008 字节，是驱动工具光盘，不能作为 Windows 操作系统安装镜像。

微软列明 [Windows Sandbox 不支持家庭版](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)，[完整 Hyper-V 也不支持 Windows 家庭版](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v)。不能因为已有底层虚拟化平台就宣称这些桌面功能可直接启用。现有 VMware 能否在当前主机组合正常启动仍未验证；[Broadcom 说明](https://knowledge.broadcom.com/external/article?legacyId=76918)其与 Hyper-V/VBS 并用依赖 Windows Hypervisor Platform 的条件，不能只凭可执行文件存在认定兼容。

## 为什么需要独立的干净系统

目标是验证新用户只拿到安装包后能否完成第一次使用。当前开发机已有开发工具、缓存、权限配置和测试记录，可能掩盖漏带依赖、依赖 PATH、默认数据目录不可写、密钥加密或首次沙箱初始化等问题。先前去掉开发 PATH、使用新配置并安装/卸载的检查仍有价值，但不能替代独立系统。

“干净”指没有预装本项目开发环境、没有旧应用配置；可以使用单独虚拟机或另一台 Windows 电脑。无需格式化或重装用户当前电脑。已有、含私人数据或其他软件配置的虚拟机不能直接当成干净系统，也不能擅自清空或回滚它。

## 对本机的预期影响与决定边界

运行虚拟机会占用分配的内存、CPU 和磁盘，可能让同时运行的任务变慢、增加风扇和电池消耗。关闭虚拟机后计算资源释放，虚拟磁盘仍保留。用户已同意可以新建专用虚拟机，先按 4 个虚拟 CPU、8 GB 内存、80 GB 按需增长虚拟磁盘规划；这些参数尚未实际配置，磁盘实际占用随系统安装、更新和快照增长，安装镜像另占空间，不能承诺固定的小体积。

客体中的安装/卸载通常写入虚拟磁盘；共享目录、剪贴板和网络会建立主客体联系，因此验收时只提供必要文件，优先只读传入安装包，不映射用户项目或整个磁盘。虚拟机不能解释为“对主机完全零影响”。

新建测试虚拟机已有用户授权，不重复询问此项。用户进一步选择微软官方 90 天评估版；已准备 `D:\make-codex\.local\vm` 专用目录和用途标记，确认 Git 忽略，与普通运行副本分开管理。已向 Codex 侧栏提交打开官方登记入口的请求，返回 queued；不能因此宣称用户完成登记或下载。尚未创建虚拟机或取得 ISO。需要购买授权、升级/替换已有 VMware、改变主机系统功能、安全设置或重启时，先说明具体影响再取得决定；不为测试自动禁用 VBS、内存完整性或其他安全防护。

微软提供[用于虚拟机的 Windows 11 x64 ISO](https://www.microsoft.com/en-us/software-download/windows11)，也有[Windows 11 Enterprise 评估版本](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise)。实际使用前核对下载版本、哈希、许可与登记要求，不使用第三方修改镜像，不将宿主机安装助手当成虚拟机安装入口。

评估版官方要求先登记，期限 90 天，不需要产品密钥；[登记入口](https://info.microsoft.com/ww-landing-windows-11-enterprise.html)中的个人信息和安装期间要求的账户登录由用户完成。选择简体中文 x64 Enterprise ISO，保存至上述专用目录后记录确切版本、体积和 SHA-256，再创建测试系统；当前网页标题不代替所下载镜像的版本检查。评估结束前导出必要验收结论，测试机与 ISO 的清理单独核对，不混入一般 `.local/runs` 清理。

## 后续最小验收

在确认的独立 Windows 环境中，使用精确哈希的候选安装包检查：普通用户安装与默认配置目录、捆绑运行时、密钥加密与预算、中文空格路径、真实工具权限/停止、审阅应用、重启和卸载数据保留。API 调用仍受同一开发预算控制。记录系统版本、初始状态和结果；未运行前保持待验收，不以虚拟机软件存在替代。

2026-10-20 用户要求保存记录并关机，准备工作已暂停。暂停检查时专用目录只有用途标记，没有 ISO 或虚拟磁盘；没有启动下载、安装或虚拟机创建任务。用户明确恢复后再接续。
