# WS 数据源配置 v3 与迁移

实际配置只存放 PrivateRoot/config/integration.json，界面可完成普通操作。权威校验器是 integration/source_config.py；Schema 和脱敏示例位于 defaults。顶层版本为 3，旧 v1/v2 可升级，未来版本拒绝覆盖。

v3 顶层字段：version、sources、enabled（定时总开关）、daily_time（HH:MM）、initial_days、lookback_days、cache_limit_mb、identity、schedule_action（summary/tasks）。连接字段只有 id、platform、account_id、account_name、db_dir、enabled。账号/目录绑定及来源账本沿用稳定 ID；换账号分配新来源，同账号重新绑定保留原关联。账号显示名称可编辑，不充当身份键。

会话选择和时间范围存于 config/summary.json，版本仍为 1。它是工作台与定时任务的唯一会话目标。选择即按用户本轮明确授权成为可采集与可分析的对象；选择本身不发送 AI 请求。调用只处理执行时快照中的源、会话和时间范围。

升级前备份原配置到 backups/integration-v1-before-v3.json 或 integration-v2-before-v3.json。升级移除 remote_scope、source.remote、source.groups、source.range、source.schedule、asr_enabled 和 remote_asr，不将其重新写回配置。保留已有会话选择；仅在没有保存选择文件时，以旧连接的已选会话形成初始选择（最多 20 个）。原分源定时收敛为会话页的统一每日规则，升级后可直接检查和修改。

普通数据导出仍使用独立标识的 WS-PRIVATE-MIGRATION 文件夹，任务、设置/签名、选择和历史可分别选择。默认不导出凭据、profile 或 session；导出的源停用、本机目录清空，定时关闭，来源和选择关联保留。在新 PrivateRoot 导入普通数据后重新连接，不能解密机器绑定凭据时也不删除任务。MCP 仍使用独立配置文件中的只读访问范围，不限制工作台。

主程序、worker、MCP、构建和日志沿用统一 PrivateRoot 解析：显式绝对 WS_PRIVATE_ROOT 优先，否则使用程序旁 WS-Private；目录联接解析后使用实际目录。公开程序与私密根分离。微信等客户端原始目录原位只读；不会迁入或清理。构建拒绝选定输入树中的目录链接，不会沿链接收录个人数据。

更新前正常退出 WS，完整保留 PrivateRoot，只替换公开程序。回滚时退出后恢复本次保存的旧程序与升级前 integration.json；同时保留完整任务、凭据和 Electron profile/session/Local State。已明确移除的语音模型不在回滚时自动下载；清理清单保存在 PrivateRoot。
