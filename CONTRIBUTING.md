# 本地开发与贡献

当前支持 Windows 11 x64。先阅读 README、docs/DEVELOPMENT_WINDOWS11.md、docs/PRIVACY.md 和 docs/LICENSE_REVIEW.md。保留用户已有改动，修改前建立不含私人资料的可回退基线。

围绕真实问题进行小范围修改，保留任务、配置与数据兼容；删除模块前检查动态加载、脚本、测试、打包和文档引用。变更后运行相关 Node/Python 回归，必要时在隔离 PrivateRoot 中实际启动和检查包内容，分别报告静态、构造测试与真实账号验证。

提交只包含已审核源码、锁文件、脱敏模板、公共测试及许可。不要上传 WS-Private、runtime、dist、node_modules、聊天库、WAL/SHM、账户配置、截图、日志、迁移包或凭据。检查工作区、暂存和可达历史；.gitignore 不清除已跟踪内容。

原创贡献须有足够权利按 Apache-2.0 提供，第三方声明原样保留，不把无授权来源改标为项目许可。仓库和发布方式待维护者确认；本次本地准备不授权任何推送、PR 或 Release。
