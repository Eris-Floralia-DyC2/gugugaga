# 开源调查与技术决策

调查于2026-10-19至20。以下为访问项目主页和官方资料得到的功能/许可证信息，并非对每个候选都安装运行。没有复制候选项目的源码或受保护素材。没有把文档声称直接写成WS的测试结果。

## 候选项目

| 项目                                                                           | 栈/目标与许可证                                  | Windows与可复用程度                                        | 窗口/外部UI/扩展判断                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Rainmeter](https://github.com/rainmeter/rainmeter)                            | C++，Windows桌面定制；GPL-2.0                    | 成熟桌面机制参考；改成Web任务/LLM架构的成本较高            | 桌面层/位置/主题可参考；没有独立安装测它的Win+D/多屏行为；其皮肤不是本需求的受控HTML模板 |
| [Lively](https://github.com/lively-community/lively)                           | C#/WinUI，动态壁纸；GPL-3.0                      | Windows动态壁纸、暂停策略参考；接管壁纸超出WS范围          | 网页和GIF等动态能力可参考；本轮未跑它验证资源占用或Win+D交互                             |
| [Zebar](https://github.com/glzr-io/zebar)                                      | Rust/Web，跨平台任务栏/小组件；GPL-3.0           | 很接近Web小组件结构；依赖完整原工程构建体系                | 可定制Web组件；需额外实现便携任务、密钥和受控模板边界，未实测桌面层硬要求                |
| [Super Productivity](https://github.com/super-productivity/super-productivity) | TypeScript/Angular/Electron，待办与时间管理；MIT | 可参考任务体验；完整应用的范围大于桌面小组件               | 任务成熟不代表符合桌面层/Win+D/直接JSON编辑要求；重写存储和桌面集成成本较高              |
| [DeskX](https://github.com/Felix-au/DeskX-Wallpaper-Engine)                    | Electron/Koffi，动态壁纸与交互小组件；MIT        | 证明Electron/Win32路线存在实践；用于方案参考，没有复用代码 | 项目主页描述WorkerW、多屏和分层；并未在本机运行它确认兼容性                              |
| [YASB](https://github.com/amnweb/yasb)                                         | Python，Windows状态栏                            | 主题/配置参考；不是HTML/CSS任务应用                        | 当前页许可证标识未进一步核实，因此不复制代码；不以PyQt定制替代Web要求                    |

这些仓库的页面在本轮可访问。没有可靠取得所有仓库最新提交日期（GitHub匿名API受到限流），因此不编造维护频率或“最新版本已支持”的结论。不同候选的CPU/GPU/内存没有同机基准，不能给出虚构性能排行。

## 框架比较

| 方案                     | 优点                                                         | 本轮证据与取舍                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri + Rust + WebView2  | 系统WebView、Rust服务、Web UI                                | [官方依赖](https://v2.tauri.app/start/prerequisites/)要求Rust/C++工具链。本机有WebView2，无现成cargo/rustc；未安装新系统工具链，也未运行Tauri原型，不声称其Win+D通过 |
| Electron + Web + Koffi   | Chromium、成熟托盘/多屏/安全IPC，可调用Win32，直接文件夹分发 | 本机Node可用；实际原型Win+D和普通窗口覆盖通过；真实EXE、HTML/CSS热更新、GIF/APNG和混合DPI已做集成测试，选择此栈                                                      |
| .NET + WebView2 或原生UI | 原生窗口控制清晰，可结合WebView                              | 需要另一套桥接/发布/依赖方案；本轮未做原型，不能认定更可靠                                                                                                           |

选择从零实现精简WS，保留独立Win32模块和领域层。Electron发布体积和多进程内存是明确代价；不能把它宣传为与Rainmeter相同的轻量级。真实指标见测试报告；未来可基于同一验收用例再比较Tauri。

## 关键官方资料

- [Electron窗口](https://www.electronjs.org/docs/latest/api/browser-window)、[屏幕/DPI](https://www.electronjs.org/docs/latest/api/screen)、[安全](https://www.electronjs.org/docs/latest/tutorial/security)。透明无边框窗口不依赖框架自带缩放，WS用独立边缘手柄。
- [Microsoft SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)：SetParent不自动修正WS_CHILD/WS_POPUP，跨进程/DPI存在兼容风险。WS实测后处理样式、坐标和异步DPI消息。
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)：Windows使用DPAPI，保护边界不能扩展为同用户程序间隔离。本项目锁定44.9.0；升级Electron时须检查同步API变更，不能只照抄latest文档。

## 未来聊天连接器调查边界

[飞书历史消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[QQ机器人官方文档](https://bot.q.qq.com/wiki/)、[企业微信开发文档](https://developer.work.weixin.qq.com/document/path/91360)是后续接入入口。飞书不同token/群类型/应用权限、QQ机器人场景授权、企业微信管理员开通和会话存档范围不能等同于普通个人账号任意读取全部聊天。

本轮没有为这些平台申请权限、登录机器人、创建应用或验证用户群访问；官方页面部分为动态加载/无法完整获取，因此不固化当前配额或声称某账号有权限。微信个人聊天优先用户主动导入/截图OCR；不采用绕过客户端、解密数据库或非授权注入方案。所有真实接入须重新核实官方许可和用户授权后实施。
