# WS 0.3：部署、配置与私密迁移

适用 Windows x64。解压整个公开发行包后启动 WS.exe；需要同级 resources 和 runtime，不需要安装 Python、Conda 或 Node。程序保留原桌面小组件、管理窗口、任务文件、主题与多屏实现。

## PrivateRoot

主程序默认读取 EXE 同级 WS-Private；开发模式为项目根目录下 WS-Private。绝对环境变量 WS_PRIVATE_ROOT 可显式覆盖。worker/MCP 默认按相同规则解析；兼容的 --data 参数可显式指定同一个目录。启动工作目录不参与解析。

“程序与数据”显示实际目录，可选择其他位置迁移，也可选择新的空 PrivateRoot。默认入口通过 NTFS 目录联接连接新位置，不在公开配置写入个人路径。迁移助手等待主进程退出、释放 profile 后复制并逐文件校验，再切换入口；原目录完整保留。失败记录在原 PrivateRoot/logs/relocation.json。自定义环境变量绑定须在启动环境中调整。

tasks 为原任务库；config 保存实际设置和 API 加密文件；secrets 为 DPAPI；databases 为消息索引；cache/attachments 为媒体副本和结果；cache/decrypted 为可清理解密数据库；models 为本地模型；logs、temp、backups、exports、transactions、legacy 分别保存私密日志、临时数据、备份、迁移包、事务和旧副本。Electron profile、session、Local State 和崩溃目录均留在 PrivateRoot。不得将整个 cache 当作可丢弃目录。

原始微信/QQ 客户端目录只作本机只读绑定，不搬动、不改写。程序更新仅替换公开文件，不覆盖 WS-Private、目录联接或其中的备份。

## 界面操作

在“消息与 AI 任务”中添加数据源，选择平台、稳定账号 ID 和原始目录。微信账号 ID 对应 db_storage 的上级目录名；重新导入数据库密钥或使用只读获取入口。飞书先在原连接器完成 OAuth，再导入授权，填写匹配当前用户的 open_id、union_id 或 user_id。QQ 当前仅保留配置入口，采集适配器尚未实现，检测会明确提示。

选择会话时显示名称和稳定 ID；按 ID 保存，允许多个同名群。可按数据源设置开始/结束时间和每日规则。未指定开始时间时采用首次回看天数，后续增量使用重叠窗口。范围改变会重新建立该范围的游标绑定，消息和任务仍按原稳定 ID 去重。

换账号或平台创建新内部 ID，并清空群及外发授权。仅更换同一账号目录保留 ID；密钥绑定失效时重新导入。停用/移除只影响采集配置，正式任务不会删除。移除源保留历史和当前凭据；如需清理，先使用独立的“清除当前凭据”或“删除消息历史”。删除历史先备份消息库，保留正式任务及任务导入去重记录。已有私密备份不会因这些操作删除。

连接检测返回目录缺失、账号不匹配、密钥未配置、授权过期、网络/权限失败或适配器未实现等原因。授权失败不代表任务应删除。

外发授权按源及群稳定 ID、文字/文档/转写/图片分别设置，新增群默认无授权。LLM API 页保留原服务、模型和密钥设置；更换服务地址会撤销已有外发范围，需要重新选择。未启用远程 ASR；本地语音失败不会自动上传音频。

MCP 在消息设置中选择源、群及启用状态；默认关闭。外部客户端启动 runtime/ws-worker/ws-worker.exe --mcp，并设置绝对 WS_PRIVATE_ROOT，或使用 --data 指向同一目录。仅提供授权范围内的只读查询。不要在命令行放 Token 或 API Key。

## 两种迁移

**干净部署**：只复制公开程序包。包内没有 WS-Private、原账号、任务、消息、profile 或凭据。首次启动后重新配置。

**本人私密迁移**：“程序与数据”选择任务、设置、历史，导出单独的 WS-PRIVATE-MIGRATION 文件夹。包保存在 PrivateRoot/exports，不进入公开发行包。任务选项含去重记录；设置含主题、窗口、总结对象选择和源 ID；历史含消息/分析、总结和附件副本。当前版本始终不导出凭据、profile/session 或解密数据库，设置中的本机原始目录、定时运行和外发授权会重置。

在目标程序选择新的空 PrivateRoot，再导入该文件夹。支持格式版本检查、逐文件 SHA256、任务/设置/消息库校验、事务前备份与失败回滚；拒绝较新版本、损坏文件和路径越界。目标已有任务或消息时拒绝覆盖，需使用空目录。导入完成重启，重新选择本机目录并授权；普通任务及来源记录仍保留。

迁移包含私密信息，应单独保管；按需复制整个迁移文件夹到本人另一台电脑，不将其放进公开发行目录。DPAPI/safeStorage 密文不保证跨电脑或跨 Windows 用户可解密。原始 profile/session/Local State 只在完整同机 PrivateRoot 迁移时保留，不能用于代替跨机重新授权。[Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) 与 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage/) 说明了相应账户依赖。

## 回滚

先从托盘退出 WS。每次导入的事务前文件保存在 PrivateRoot/transactions/事务ID/before，journal.json 标记 preparing/committing/committed/rolled-back。启动时发现未完成提交会自动恢复；已完成导入如要撤销，先另备份当前数据，再按 journal 恢复 before 内原有文件，原先不存在的文件按清单处理。

完整目录迁移失败会保留原入口；成功后旧目录保留，可从 relocation.json 核对来源。归拢的历史文件在 legacy 内，consolidation 清单记录每个原路径、目标及哈希。只有核对这些明确清单才能恢复；不要批量删除原文件夹或删除 profile。

应用降级前备份当前 PrivateRoot。旧版程序不支持配置 v2，恢复旧程序时使用备份中的 v1 配置；正式任务要使用最新副本，避免覆盖用户迁移后新增或修改的任务。

0.4.0 升级说明：配置规范更新为 v3，移除旧采集/外发权限和语音字段；选择本身不发请求。迁移保留来源和会话选择，重新绑定机器连接后即可执行。详见 WS_040_MIGRATION.md。
