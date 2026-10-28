# 给 Agent 的 Windows 11 安装与升级指南

适用对象：具有本机文件、终端工具的安装 agent。本文是普通仓库文档，不是需要额外安装的 Skill。先读本文件及 README，再按实际源码执行；不要把文档中的示例当作已发生的操作。

## 输入与授权

从用户消息或当前仓库取得：真实源码仓库/本机源码路径、安装目录、需要安装的功能，以及新装或升级。未给仓库地址时询问，不猜地址。仅做已授权的本地安装或升级；安装请求本身不授权 GitHub 推送、发布、上传个人数据，也不授权调用远程模型处理聊天。

用户已提供的路径和选项直接沿用。保留现有修改、任务、设置及回退材料；不要求用户反复确认已授权的普通步骤。扫码、验证码、设备确认等认证由用户完成。缺少关键选择或遇到不可逆操作时才停下说明。

## 1. 只读预检

读取适用的 AGENTS.md、README、package.json、package-lock.json、integration/requirements-lock.txt、docs/SOURCE_DEPLOYMENT_WINDOWS11.md、DEVELOPMENT_WINDOWS11.md、PRIVACY.md 和 QQ_THIRD_PARTY.md。版本、路径、入口和命令以当前文件为准，不混用旧 BUILD 文档。

在 PowerShell 检查 Windows 11 x64、Node/npm、Git，以及可选 Python。当前源码要求 Node >=22.12.0；消息运行时使用 Python 3.13 x64。检查已有依赖后复用，不重复装全局工具、不修改系统代理、执行策略或安全配置。不要默认需要管理员权限。

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
[Environment]::Is64BitOperatingSystem
Get-Command node, npm.cmd, git, python -ErrorAction SilentlyContinue
node --version
npm.cmd --version
```

已有源码时检查 Git 状态，保留用户工作区与暂存内容，不 reset、不强推。新装只克隆用户指定仓库到新目录；已有非空目录不得直接覆盖。仓库/目录未确定时不要执行含占位符的克隆命令。

## 2. 私密目录与依赖

默认私密目录为项目旁的 WS-Private；便携程序为 WS.exe 旁的 WS-Private。用户指定 WS_PRIVATE_ROOT 时必须是绝对路径，源码、Electron、worker 和测试共用该边界。不要把源码目录本身或 src/runtime/dist 等公共输入目录作为 PrivateRoot。只设置当前进程及子进程的环境变量，不擅自写系统环境。

升级前确认实际私密目录，包括联接和环境覆盖；不要因为新目录为空就假定旧任务丢失。数据、凭据、profile/session、聊天缓存、日志、截图与测试结果均不得提交到 GitHub。诊断时不打印密钥、Token、二维码或聊天原文。

进入核实后的源码根目录，使用锁文件安装：

```powershell
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败；保留实际错误并排查' }
```

ci 会重建该项目 node_modules；已有手工修改时先保留。安装成功只能证明依赖阶段完成，不能声称窗口或数据源可用。

## 3. 基础运行与隔离验收

先用独立测试 PrivateRoot 验证窗口、虚构任务新增、日期分组、保存、真正退出和重启。不要接入正式账号或触发正式自动计划。源码运行入口为 npm.cmd start；公开完整程序运行 WS.exe。

```powershell
# 路径由 agent 根据本次安装位置生成；使用全新、可识别的测试根。
$testRoot = Join-Path (Get-Location) ('WS-Private\validation\install-' + [guid]::NewGuid())
$env:WS_PRIVATE_ROOT = $testRoot
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw '核心测试失败；不要继续覆盖正式程序' }
```

测试结束后恢复本进程原 WS_PRIVATE_ROOT，不能把测试目录当作正式启动目录。核对普通任务在截止日当天仍属于今日待办，次日才按原计划进入历史；任务 ID 和存储日期不应改变。

## 4. 可选消息和 AI 功能

没有消息功能需求时，手动待办可以独立使用。需要消息功能时，先核实 Python 3.13 x64，再创建或复用已核实的项目 .venv，按 integration/requirements-lock.txt 安装依赖；不覆盖未知虚拟环境。不要求激活环境，不为了运行脚本而全局放宽执行策略。

源码优先使用 runtime/ws-worker/ws-worker.exe，缺失时使用项目 .venv/Scripts/python.exe integration/worker.py。完整便携包必须自带 worker，不能依赖另一台机器上的开发目录。

微信、飞书、QQ 仅按用户授权配置。QQ 按 QQ_THIRD_PARTY.md 获取并核对固定版本 QCE 6.3.2 资源、哈希和独立许可；不自动替换用户 QQ、不复制别人的 profile、不默认接入私聊。不把可选 QQ 资源误判为手动待办的必需条件。

API Key 只在本机 AI 服务界面输入，不放命令行、文档、Git 或聊天。先做不含个人消息的连接测试；真正总结/任务分析前明确数据源、会话、时间范围及目标服务。总结与任务分析的附加提示词和输出上限分别配置，内置格式及来源核对仍生效。已保存的旧结果不是本次真实联调证据。

## 5. 打包、升级与回退

构建命令与独立 worker 准备步骤严格按 DEVELOPMENT_WINDOWS11.md。只构建已授权需要的程序；复用未变化、已核实的 worker，不盲目重复构建。保留 Apache-2.0 根许可及所有第三方许可、NOTICE；不能用 WS 许可替换第三方条款。

升级使用以下顺序：

1. 确认用户已真正退出 WS；只检查目标 WS 进程，不结束 QQ 或其他应用。
2. 在原 PrivateRoot 内备份任务、设置、状态及需替换的源文件；消息数据库使用一致性备份。保留可恢复的原程序。
3. 先在隔离目录生成并验证新程序。程序扫描见 scripts/audit-public.py；检查私密目录、链接、凭据与许可证边界。不要把现有带个人数据的便携目录直接作为公开包。
4. 替换完整公共程序资源，保留原 PrivateRoot 及其联接，不用空任务库覆盖正式任务。单纯更新显示规则不应重写任务日期。
5. 比对备份与当前任务、设置、选择，检查真实程序版本。失败则恢复旧公共程序；涉及数据恢复前核对是否会覆盖用户的新编辑。
6. 重新启动前核对定时计划是否将补跑并调用 AI。已有授权不涵盖新的外发范围时，先保留程序关闭并说明；否则按用户授权启动。不要伪造成功日期来绕过调度。

递归删除或移动前，解析绝对目标路径并确认仍在预期目录内。仅清理本次创建、用途已确认且可再生的测试产物；保留未知文件、个人数据和回退材料。

## 6. 交付记录

分别报告：实际版本/路径、备份与回退位置、依赖安装、核心测试、打包程序验证、正式启动状态、可选数据源状态和真实模型联调。区分本机模拟服务、真实 Windows 窗口及真实第三方服务；未验证项目明确说明。不要用命令退出码代替 GUI 启动或数据保存验收。

如没有工具权限，只给可执行步骤与成功标准，不声称已安装。遇到失败，记录阶段、错误码和脱敏日志位置，沿源码逐项排查，避免循环重装。
