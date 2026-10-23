# Windows 11 源码部署

所有命令在 PowerShell 执行；目录示例为虚构路径。只支持 Windows 11 x64，不需要管理员终端。请先阅读 README 和 PRIVACY.md。

## 1. 核实环境，获取源码

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
[Environment]::Is64BitOperatingSystem
Get-Command node, npm.cmd, git, python -ErrorAction SilentlyContinue
node --version
npm.cmd --version
```

应为 Windows 11、64 位，Node >=22.12.0。该下限来自锁定的 @electron/packager 20.3.0 元数据；本次 Node 验证版本为 24.14.1。不满足时从 Node 官方网站安装适用版本；已有可用版本无需重复安装。Git 只在克隆时必需，也可解压已审核的源码 ZIP。源码仓库地址如下：

```powershell
$repositoryUrl = 'https://github.com/Eris-Floralia-DyC2/gugugaga.git'
git clone $repositoryUrl WS
Set-Location -LiteralPath .\WS
Get-Item .\package.json, .\package-lock.json, .\src\main.js
```

解压方式请把整个源码放在普通可写目录（例如 `D:\Apps\WS`），不要覆盖已有 WS。之后先 `Set-Location -LiteralPath 'D:\Apps\WS'`。后文均在该项目根目录执行。

## 2. 基础安装与启动

```powershell
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请根据实际错误排查' }
npm.cmd start
```

`ci` 按锁文件安装，会重建当前项目的 node_modules；如其中有手工改动先保存。安装过程访问 npm/Electron 下载地址，不能把安装命令成功等同于桌面启动成功。不要执行建议中的全局升级命令来掩盖错误。

默认配置自动生成在项目根目录 `WS-Private`，无需手工复制示例配置。首次检查：桌面能看到 WS，托盘打开管理窗口，在任务页新增虚构任务、完成/撤销；退出 WS 再启动，确认任务保存。消息运行时未准备时可能显示相关错误，但手动待办仍可用。

需要自选数据目录时，**第一次启动前**在当前 PowerShell 会话设置绝对路径：

```powershell
$env:WS_PRIVATE_ROOT = 'D:\WS-Private'
npm.cmd start
```

不要设为源码的 `src`、`defaults`、`runtime` 或 dist；不要指向他人的目录。此变量只影响当前会话及子进程，不修改系统环境。已有数据迁移使用界面功能，不能只设置变量后假定旧数据已搬迁。私人文件均不得提交。

## 3. 可选消息运行时

先退出 WS。使用现有 **Python 3.13 x64**，确认输出后再创建项目虚拟环境；实际解释器路径按本机修改，不要求 Conda：

```powershell
$pythonExe = (Get-Command python -ErrorAction Stop).Source
& $pythonExe -c "import sys,struct; print(sys.version); print(struct.calcsize('P')*8)"
# 必须确认是 Python 3.13、64 位；否则先选择正确解释器。
if (!(Test-Path -LiteralPath '.\.venv\Scripts\python.exe')) { & $pythonExe -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install -r .\integration\requirements-lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Python 依赖安装失败' }
npm.cmd start
```

源码启动优先用 `runtime/ws-worker/ws-worker.exe`；没有该文件时使用 `.venv/Scripts/python.exe integration/worker.py`。无需激活环境或改执行策略。若已有 venv，先核实其中 Python 及依赖版本；不要覆盖未知环境。锁文件包含构建和解析依赖，不需要另外下载语音模型。

首次进入“数据源设置”按需要配置本人授权的数据源；“AI 服务”填写兼容接口的 Base URL、模型和 Key。远程必须 HTTPS，本机可 HTTP。Key 只在本机界面输入，不放在命令行或对话。进入“会话总结与任务分析”按可读名称选择会话及时间，选择会自动保存；总结不创建普通任务，任务分析写入现有任务库。启用定时任务前确认选择和发送范围。

微信需有效本地账号数据库及对应读取凭据；来源只读。飞书需已授权连接，当前实现支持从已有连接器导入，不提供无账号登录的模拟数据。QQ 还需独立 QCE Shell 资源与官方 QQ 安装，按 QQ_THIRD_PARTY.md 核对来源、版本、SHA256 和许可后在本机准备；不随源码附带，不自动下载。QQ 缺失不影响其他来源及手动待办。

### QQ 首次准备需要做什么

不必分别寻找 QCE 和 NapCat。按 [QQ 第三方资源说明](QQ_THIRD_PARTY.md) 从固定版本官方页面取得 **NapCat-QCE-Windows-x64-v6.3.2.zip**（包含 NapCat），核对该文档的 SHA256 后，将文件保存为项目中的 `runtime/qce-shell-v6.3.2.zip`。普通源码运行使用这个 Shell 资源；如果要打包分发，还必须保留该文档要求的对应源码和全部许可文件。

确保本机已有官方 QQ，然后在 WS 的数据源设置中准备 QQ 环境并选择已安装的 `QQ.exe`。WS 会创建专用副本、解压资源并生成本机配置；本人完成扫码、验证码和账号确认，再选择授权会话。WS 不会自动下载这些第三方资源，且不应把别人的 QQ profile/登录目录复制过来。既有本机用户升级时保留原 PrivateRoot 和资源，无需重新配置。

## 4. 成功标准

基础部署：窗口可用、任务可保存、退出重启后存在。消息部署：数据源测试通过、会话可列出、指定时间范围可采集。AI 部署：测试连接得到模型文本；再对最小授权范围实际总结/分析，人工核对引文和任务。各阶段独立验收，不能用其中一个替代另一个。

继续阅读 USER_GUIDE_WINDOWS11.md、FAQ_WINDOWS11.md。打包程序另见 DEVELOPMENT_WINDOWS11.md；普通源码使用不需要先构建 EXE。
