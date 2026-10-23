# Windows 11 开发与打包

先完成 SOURCE_DEPLOYMENT_WINDOWS11.md。所有命令在项目根目录运行，使用 PowerShell。

## 结构和调用链

`src/main.js` 是 Electron 主进程，初始化 PrivateRoot、任务库、配置、主题、Windows 原生窗口和 Integration。`src/preload.cjs` 提供固定 IPC；renderer 调用经发送窗口和主 frame 校验进入主进程。任务修改进入 `core/storage.cjs` 的 TaskRepository，经 `tasks.cjs` 校验、备份及原子写入后广播刷新。

`core/integration.cjs` 通过 stdin/stdout JSON 启动独立 Python worker；`integration/worker.py` 分派给微信、QQ、飞书适配器，消息落入 PrivateRoot 的 SQLite。`analysis.py`/`summaries.py` 调用配置的 AI，再校验出处、保存结果；任务通过 `task-api.cjs` importer 写入原任务库。QQShell 单独管理专用 QQ 后台。MCP 是独立只读接口，不负责 AI 推理。

`defaults` 是公开模板和虚构任务；`assets` 是图标；`test` 与 `integration/tests` 是构造数据回归；`scripts` 负责测试/打包/许可/本地扫描。`runtime` 是本机构建及可选第三方二进制，不提交；`dist` 是构建产物；`WS-Private` 是私人数据及开发临时文件，不提交。`connectors.ts` 为保留的扩展契约，无当前运行导入，不据此扩展平台或删除公开契约。

## 开发与自动化测试

```powershell
npm.cmd start
# 在另一个 PowerShell 中、同一项目根目录：
$env:WS_PRIVATE_ROOT = Join-Path (Get-Location) 'WS-Private\validation\unit'
npm.cmd test
$env:WS_TEST_TMP = Join-Path $env:WS_PRIVATE_ROOT 'temp'
New-Item -ItemType Directory -Path $env:WS_TEST_TMP -Force | Out-Null
$env:PYTHONPATH = Join-Path (Get-Location) 'integration'
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
& .\.venv\Scripts\python.exe -m unittest discover -s integration/tests
```

Node 测试应显示 fail 0；Python 显示 OK。HTTP/模型相关测试使用构造服务，不代表真实供应商、真实账号或实际多屏硬件通过。测试可能运行数分钟。不要把正式 PrivateRoot 当作测试目录。

## 构建独立运行时和便携程序

```powershell
$env:WS_PRIVATE_ROOT = Join-Path (Get-Location) 'WS-Private\development'
# 已按锁文件准备 .venv；如复用外部构建环境，可设置 WS_BUILD_PYTHON 为其绝对 python.exe 路径。
powershell.exe -NoProfile -File .\scripts\build-worker.ps1
if ($LASTEXITCODE -ne 0) { throw 'worker 构建失败，先检查输出' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Electron 打包失败' }
```

执行脚本受策略限制时先查看组织/本机策略；无需激活环境或全局改策略。脚本拒绝覆盖已有 `runtime/ws-worker`，先核实并把旧运行时归档到 PrivateRoot，不要直接删未知目录。

成功生成 `runtime/ws-worker/ws-worker.exe`，以及唯一 `dist/WS-Clean-<package.json版本>-<时间戳>/WS.exe`。需保留整个便携目录和许可证，不能只复制 EXE。不包含 QQ 资源时可运行待办及其他来源，QQ 准备会提示资源缺失；需要 QQ 时按 QQ_THIRD_PARTY.md 准备四件资源/源码/许可，不直接复制个人目录。

构建输入采用白名单，拒绝链接、runtime 未审核文件及明显私人数据类型；这不能替代内容检查。本次打包 scratch 在成功/失败后自动清理，保留新输出；设置当前会话 `WS_KEEP_BUILD_SCRATCH=1` 可临时保留用于诊断，随后人工核对。不删除旧 build、备份或发布目录。`WS_ELECTRON_ZIPS` 可指定含对应官方 Electron ZIP 的本地目录。PyInstaller 的分析工作目录保留在 PrivateRoot 以便诊断。

## 桌面和产物验证

```powershell
# 使用本次构建的真实完整路径替换示例
$env:WS_TEST_DATA = Join-Path $env:WS_PRIVATE_ROOT 'validation\smoke'
& '.\dist\WS-Clean-<版本>-<时间戳>\WS.exe' --smoke-test
```

预期退出后生成 `$env:WS_TEST_DATA\logs\smoke\smoke.json`，所有 results 为 pass。测试含实际窗口、隔离任务和模拟 HTTP 服务，不使用个人账号。它会暂时显示测试窗口，不代表实际设备插拔、休眠唤醒或商业 AI 验证。

产物静态扫描：

```powershell
& .\.venv\Scripts\python.exe scripts/audit-public.py '.\dist\WS-Clean-<版本>-<时间戳>' --embedded-python --report "$env:WS_PRIVATE_ROOT\validation\package-scan.json"
```

报告含候选位置/类型，不含秘密值；非零退出表示有候选或未检查内容，必须复核。扫描支持 ZIP 和 PyInstaller Python 模块，不能覆盖所有压缩/加密格式。报告放在 PrivateRoot。旧 `audit-release.py` 现在转发给同一只读工具，不再初始化正式状态或读取聊天作匹配样本。

## 提交前

检查 `git status --short`、`git diff`、`git diff --cached`，明确已有暂存内容；只选择实际审核过的文件，不使用 `git add .`。单独检查历史、分支、标签、ZIP 和嵌入模块；.gitignore 不会移除既有跟踪或历史秘密。源码导出应排除 private/runtime/dist/node_modules/.venv/缓存，保留源码、锁文件、公开测试和许可。任何上传、推送、仓库创建、PR 或 Release 需另行明确授权。
