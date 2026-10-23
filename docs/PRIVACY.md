# 隐私和联网说明

## 本地存储

统一 PrivateRoot：绝对 `WS_PRIVATE_ROOT` 优先；否则开发时在项目根目录、打包时在 EXE 旁的 `WS-Private`。迁移可能使用 `WS-Private` 目录联接或 `.pending` 恢复指针，不能将链接目录当作干净发布包。

| 路径（相对于 PrivateRoot）                                  | 内容                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| tasks/tasks.json、backups                                   | 待办和备份，可能含个人事项                                |
| config/settings.json、integration.json、summary.json、rules | 设置、账号标识、源路径、选择范围与提示词                  |
| config/credential.dpapi、secrets/*.dpapi                    | Electron safeStorage / 当前 Windows 用户 DPAPI 保护的凭据 |
| databases/messages.sqlite3、summaries、state                | 消息正文/处理进度、总结、引用及账号状态                   |
| cache/attachments、cache/decrypted、exports、temp、logs     | 附件、解密副本、私密迁移、临时数据和诊断                  |
| cache/profile、cache/session、qq                            | 浏览器状态，专用 QQ 客户端、登录信息和 QCE 附件           |

PrivateRoot 不是整体加密保险箱。任务、消息库和部分第三方 QQ token 文件为本地明文；同一 Windows 用户可访问。第三方组件 token 由其协议管理，不能把它们描述为全部经 DPAPI 保存。程序拒绝在 safeStorage 不可用时明文保存 AI Key。跨 Windows 账户/机器或 profile 变化可能无法解密，需重新输入或授权，不能自动清空任务。

## 联网和对外内容

- 纯手动待办无需账号或模型。安装/构建访问包注册表和 Electron 下载服务；项目没有自动 GitHub 上传流程。
- 微信来源数据库只读，处理副本和缓存在 PrivateRoot。只应读取本人有权访问的账号与会话。
- QQ 通过本机 QCE HTTP 接口采集，QCE/NapCat 和官方 QQ 联网登录/同步消息；WS 管理专用副本，本机 API 使用回环地址和 token。登录 URL/剪贴板可能包含本机登录 token，勿截图分享。QQ 资源会下载、复制附件，可能占用大量空间。
- 飞书通过 OpenAPI 读取授权范围的会话和附件，可能刷新 OAuth 凭据；从已有连接器导入不扩大原有权限。
- 点击总结、任务分析或启用定时执行后，会把选中来源/时间的文本、会话名、发送者名、时间、身份说明，以及按功能处理的文档文本、图片视觉输入/结果发送给所配置 AI 提供商。任务分析还可发送现有来源任务的标题及完成状态，用于去重。语音不解析，不发送语音转写。具体范围以当前代码和页面选择为准；不能把“本地采集”理解为“AI 永不联网”。
- “测试连接”发送最小测试请求，不使用聊天正文；Key 通过请求认证头发送给指定接口。远程接口需 HTTPS，不跟随重定向，第三方保留策略由提供商决定。
- MCP 是用户主动启动的独立只读服务，外部客户端可按其 allowlist 读取本地消息。打开 MCP 配置目录不会启动服务或自动推理；向外部模型开放该服务前需自行核对访问范围。

## 公开材料边界

私人目录、迁移包、聊天库及 WAL/SHM、截图、日志、token、配置、数据库密钥、浏览器会话和私人样本不得进入源码或发布压缩包。构建白名单与忽略规则只是防线，公开前还要检查暂存、可达历史、ZIP 和嵌入代码。PrivateRoot 已被 Git 跟踪时，增加 .gitignore 不会解决泄露；应保留原文件，审查停止跟踪方案及凭据撤销需求，历史改写需另外授权。

诊断只共享必要错误类型和脱敏位置，不粘贴 Key、Token、聊天正文、登录二维码或完整私密日志。备份/导出文件即使排除凭据仍为私人资料。详情见 USER_GUIDE_WINDOWS11.md。
