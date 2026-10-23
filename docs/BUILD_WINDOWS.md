> 历史构建记录；当前 Windows 11 安装和构建请使用 [源码部署](SOURCE_DEPLOYMENT_WINDOWS11.md) 与 [开发指南](DEVELOPMENT_WINDOWS11.md)。旧命令和输出路径不代表当前实现。

# Windows x64 构建

验证开发环境：Windows 11 25H2 build26200、Node24.14.1、npm11.11.0、Git2.51.0。主要依赖版本写入 package.json 并锁定 package-lock.json。

```powershell
npm.cmd ci
node node_modules/electron/install.js
npm.cmd test
npm.cmd run build
```

Node要求 >=22.12。Electron44 npm包需要显式install.js；它下载官方运行文件并校验。无需改变系统组件或安装WebView2。首次构建需要网络，代理仅按当前环境配置。可将 `electron_config_cache` 指到项目 `.electron-cache`，需要 Node 的环境代理时设置 `NODE_USE_ENV_PROXY=1`。不要关闭TLS校验。

`scripts/build.cjs` 优先使用 `.electron-cache/zips/electron-v44.9.0-win32-x64.zip`，不存在则标准下载。@electron/packager 将 src/defaults/assets/依赖放到 resources/app；devDependencies不打入运行依赖。Koffi使用Windows x64预编译模块；不同架构需要另行验证，当前不宣称支持ARM64/32位。

输出 `dist/WS/WS.exe` 与同级全部资源。必须分发整个目录。构建从独立 `.build/<uuid>` 产生程序文件，再复制公共文件到 dist/WS，跳过 data。**构建前退出旧WS**，避免EXE/DLL占用。没有构建或安装任何系统服务，不静默安装运行时。

发行包不是单文件，不提供MSI/MSIX和自动更新。Chromium/DLL是实际运行依赖的一部分，不能把“无需安装向导”解释为“不需要任何运行文件”。全新Windows镜像和企业安全策略环境应独立验证。

## 测试

```powershell
npm.cmd test
$env:WS_TEST_DATA=(Join-Path $PWD 'test-artifacts/release/data')
& ./dist/WS/WS.exe --smoke-test
```

失败返回非零退出码，详细JSON和截图在测试data上一级artifacts。测试模式强制隔离默认数据且跳过自启。`--interactive-test` 仅用于明确选择的隔离验收，包含局部截图与指标采样，正常运行不会启用截图采样。测试完成必须退出该实例。

重新生成发行包时不要把 data、test-artifacts、日志、截图、.env、凭据、node_modules或下载缓存加入源代码归档。发布许可证需同时保留Electron/Chromium和npm运行依赖通知。

## 更新

退出WS → 备份data → 替换同一发行版的全部公共程序文件（EXE、DLL/PAK、resources、locales等） → 保留原data → 启动核对。不能只换EXE后混用旧Chromium资源。失败时退出，用旧程序整套资源和升级前备份恢复。
