> 历史构建记录；当前 Windows 11 安装和构建请使用 [源码部署](SOURCE_DEPLOYMENT_WINDOWS11.md) 与 [开发指南](DEVELOPMENT_WINDOWS11.md)。旧命令和输出路径不代表当前实现。

# 0.5.0 源码构建补充

Windows x64，Node >=22.12，Electron 44.9.0，Python 3.13。本次使用项目独立虚拟环境，未依赖全局 Conda 包；完整锁定清单为 integration/requirements-lock.txt。创建 .venv、安装锁定依赖后，执行 scripts/build-worker.ps1 生成 runtime/ws-worker，再执行 npm ci 与 npm run build。

源码包不包含 node_modules、.venv、私密数据或第三方运行二进制。QQ 的固定官方 Shell 包可从 [v6.3.2 发行页](https://github.com/shuakami/qq-chat-exporter/releases/tag/v6.3.2) 获取，按 docs/QQ_THIRD_PARTY.md 的 SHA256 核验，放到 runtime/qce-shell-v6.3.2.zip。许可证、QCE 对应源码归档亦须保留。也可从同版干净便携包复制整个 runtime 目录，不能复制任何 WS-Private。

scripts/build.cjs 会生成独立 dist/WS-Clean-0.5.0-时间戳 目录，不覆盖当前在用的 WS。它要求干净 runtime/ws-worker，可使用 WS_ELECTRON_ZIPS 指定包含官方 Electron ZIP 的目录。构建暂存、下载、测试和日志均留在 PrivateRoot 下；发行时仅取公共程序文件，不能把 PrivateRoot、链接、构建缓存加入公开包。

Node 回归：npm test。Python 回归：把 integration 加入 PYTHONPATH，指定绝对 WS_TEST_TMP 到隔离临时目录，设置 PYTHONUTF8=1，然后用 .venv 的 Python 执行 unittest discover -s integration/tests。桌面测试使用 WS_TEST_DATA 指向独立目录后启动完整 EXE --smoke-test。流程测试必须先准备构造数据，不能指向正式用户数据。

现有旧版 BUILD_WINDOWS.md 记载历史构建方法；本补充及当前 scripts/build.cjs、scripts/build-worker.ps1 为 0.5.0 权威入口。
