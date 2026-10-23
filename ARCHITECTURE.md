# WS 架构

## 进程与权限

Electron 主进程拥有唯一 TaskRepository、Config、Themes 和 Credentials。小组件与管理窗口为两个独立 sandbox renderer，通过 contextBridge 暴露的固定操作调用 IPC。主进程检查发起窗口、主 frame 与本地 origin；凭据写入/LLM 请求/配置写入只允许管理窗口。没有任意文件路径读取、shell 执行或通用 IPC 转发入口。

内部 `wsapp://app/` 协议仅映射固定前端资源、DOMPurify 和经限制的背景文件名。CSP 禁止任意网络连接和外部脚本；默认拒绝浏览器权限请求与新窗口导航。任务标题/描述使用 textContent，不作为 HTML 插入。主题经 DOMPurify 白名单清洗，不提供外部 JavaScript。CSS 禁止 URL、转义和导入以阻止远程资源通道。

## 模块职责

| 路径                     | 职责                                           |
| ------------------------ | ---------------------------------------------- |
| src/main.js              | 生命周期、托盘、窗口、协议、IPC、连接模块      |
| src/preload.cjs          | 固定桥接，隔离 renderer 与 Node                |
| src/windows/desktop.cjs  | HWND、Shell 宿主、父子关系、Z 顺序、保守遮挡   |
| src/windows/geometry.cjs | DIP 工作区、吸附、相对位置与恢复               |
| src/windows/recovery.cjs | 无窗口恢复守护，Shell 重启且主进程退出时恢复   |
| src/core/tasks.cjs       | v1 Schema、领域操作、日期与重复实例、分组      |
| src/core/storage.cjs     | 权威 JSON、原子替换、备份、监听与冲突          |
| src/core/config.cjs      | 设置默认值、验证、保存和外部同步               |
| src/core/theme.cjs       | 外部主题、监听和内置回退                       |
| src/core/llm.cjs         | 端点校验、真实推理、错误分类、DPAPI            |
| src/core/performance.cjs | 正常/电池/隐藏/遮挡/锁屏策略                   |
| src/core/connectors.ts   | 未来消息/OCR/提取/审核扩展协议                 |
| src/renderer/            | 源码级业务交互、管理页、粒子、背景             |
| defaults/                | 可跟踪的公共默认主题、数据样例与 Schema        |
| test/                    | 核心测试、真实 Electron 集成与隔离生命周期测试 |

## 消息处理与私人边界（当前实现）

`core/private-root.cjs` 统一绝对 WS_PRIVATE_ROOT 或程序旁 WS-Private。Electron profile/session/temp/logs、Python 数据库/解密副本、QQ 专用副本、迁移及构建暂存均应在该根下；源码、默认模板及 runtime 输入与私人数据分开。具体路径和发送范围见 docs/PRIVACY.md。

renderer → 固定 preload IPC → main 的窗口/主 frame/origin 检查 → core/integration.cjs 的命令白名单 → 独立 Python worker（stdin JSON，无 shell）→ 各平台适配器 → State SQLite。分析/总结只处理执行时的选择快照，AI 返回经出处校验；普通任务经原 TaskRepository importer 写入、去重并保护手动修改。MCP 是另行启动的只读接口，不是模型本身。QQShell 只管理明确的专用进程路径，QQ 本机 API 使用回环地址和 token。

构建 scripts/build-worker.ps1 生成独立运行时，scripts/build.cjs 复制白名单输入并清理本次 scratch。旧 dist、用户数据及历史备份不自动清理；不能压缩含 PrivateRoot 联接的在用程序目录公开。当前部署入口为 docs/SOURCE_DEPLOYMENT_WINDOWS11.md，开发和回归入口为 docs/DEVELOPMENT_WINDOWS11.md。

## Windows 窗口与 DPI

默认将小组件设置为桌面图标宿主 Progman/WorkerW 的子窗口。普通应用是上方的顶层窗口，桌面最小化操作不会按普通任务窗口处理它。置顶模式解除父子关系并设置原生 topmost。Shell 机制未文档化，不应宣称未来所有 Windows 版本兼容。

Electron API 使用 DIP，Win32 使用物理坐标。先转换屏幕原点，再按所在显示器 scaleFactor 单独换算宽高，避免非整像素位置下反复转换外接矩形产生累计漂移；ScreenToClient 再转换到 Shell 宿主的客户区。Windows 的 WM_DPICHANGED 可能延后自动缩放，按预期逻辑尺寸重新校正。无边框拖动/缩放采用原生鼠标状态采样，不把输入框等交互区用作拖动区域。

状态按显示器 ID 保存相对位置和工作区比例。热插拔事件尝试保留首选屏幕位置并回退到当前可用工作区。实测发现 Explorer 销毁跨进程子窗口时可能连带结束 Electron 主进程；单靠进程内恢复不够。正常模式启动一个无窗口 Node 守护，监视主进程和 Explorer 的进程标识；主进程结束且 Shell 已重建才恢复一次，由新实例接管守护。主动退出先写 cleanExit，守护随之退出。不会在用户正常退出后定时重启；无系统服务、计划任务或额外自启项。具体平台兼容性以测试报告为准。

## 数据一致性

tasks.json 为唯一权威数据。每次 GUI 操作携带所见 SHA-256 revision，主进程写入前重读、解析、校验。若 revision 已变化，拒绝覆盖。无效外部文件保持原文和最近有效内存状态，阻止新 GUI 写入。

成功写入先复制旧文件到备份，再写同目录临时文件、fsync、rename，防止部分 JSON 替换正常数据。保留40份。文件监听180ms防抖。普通任务跨天只改变视图分组；每日规则在 occurrences 中按本地日期记录完成时间，不复制普通任务。

本版不包含多进程协同编辑锁，也不声称消除任意文件编辑器在“检查后、rename 前”瞬间并发保存的极窄竞争；冲突保护针对已检测的外部版本变化。备份仍是必要防线。

## 视觉与资源

背景图层 → 叠加色 → Canvas 粒子 → 内容 → 交互/缩放手柄。所有图层被小组件圆角容器裁切，粒子不接收鼠标。

主进程每2秒采样 Windows 遮挡与电源，在设置/收起/恢复/电源事件立即更新。renderer 组合原生策略与页面可见性，不允许页面事件覆盖原生暂停状态。隐藏/完全遮挡/锁屏暂停；电池限制12FPS和粒子数量；GIF/APNG用静态首帧替代并移除src。恢复会重新开始动画，不能保证从原播放位置继续。

## LLM 与后续 Agent

只有显式点击测试才由主进程发短 Chat Completions 推理。密钥从 DPAPI 解密后仅存在于主进程请求中，不回传。拒绝远程 HTTP、带凭据/查询参数的端点与重定向。响应大小上限256KB，不显示原始服务端正文，以避免错误回显秘密。

未来链路：MessageSource → MessageParser → TaskExtractor → TaskReviewer → TaskRepository。消息视为不可信文本；来源、范围、过期时间和是否允许传输应单独授权；模型输出必须通过结构验证与人工审核。当前只有类型接口，没有后台抓取、OCR、机器人权限或模型工具调用。
