# 咕咕嘎嘎（WS）0.5.4

面向 **Windows 11 x64** 的便携桌面待办小组件与工作台。支持任务新增、编辑、完成、备份，主题、背景、个性签名、多屏位置与桌面/置顶模式。可选微信本地只读采集、QQ 独立后台、飞书授权读取，以及通过兼容 Chat Completions 的 AI 服务总结会话、提取任务。语音不解析，不部署本地语音模型。

本地手动待办和外观功能无需配置账号或 AI。消息功能另外需要 Python 运行时、对应数据源授权；AI 总结/分析还需要模型及 API Key，可能产生服务费用。默认私人数据位于程序旁的 `WS-Private`，不要上传或打包该目录。

0.5.4 修复普通任务在截止日期当天未归入今日待办的问题；显示分组不修改任务存储日期。安装 agent 请优先阅读 [Agent 安装与升级指南](docs/AGENT_INSTALL_WINDOWS11.md)。

## 环境和快速开始

Windows 11 x64；Node.js >=22.12.0（本次验证 24.14.1）。锁文件固定 Electron 44.9.0、@electron/packager 20.3.0、AJV 8.20.0、DOMPurify 3.4.17、Koffi 3.3.3。消息运行时构建使用 Python 3.13 x64 和 `integration/requirements-lock.txt`；无需管理员权限或全局包安装。

先按 [Windows 11 源码部署](docs/SOURCE_DEPLOYMENT_WINDOWS11.md) 获取源码并进入项目根目录。PowerShell 中执行：

```powershell
npm.cmd ci
npm.cmd start
```

看到桌面组件、能新增并在重启后保留测试任务，说明基础功能可用。缺少消息运行时的提示不会代替消息功能验收；需要该功能时继续阅读部署文档。退出请用托盘菜单“退出 WS”。

## 文档

- [给 agent 的安装与升级步骤](docs/AGENT_INSTALL_WINDOWS11.md)
- [源码部署](docs/SOURCE_DEPLOYMENT_WINDOWS11.md)
- [使用、更新、备份和卸载](docs/USER_GUIDE_WINDOWS11.md)
- [开发、测试和打包](docs/DEVELOPMENT_WINDOWS11.md)
- [隐私与联网说明](docs/PRIVACY.md)
- [常见问题](docs/FAQ_WINDOWS11.md)
- [可复制的安装辅助 Prompt](docs/INSTALL_ASSISTANT_PROMPT.md)
- [许可清单与公开前条件](docs/LICENSE_REVIEW.md)
- [结构和调用链](ARCHITECTURE.md)

`WS_*.md`、旧版 BUILD 文档及验收报告是版本历史，不能作为当前机器已经通过验证的证据。当前安装入口以上述 Windows 11 文档及实际脚本为准。

## 许可与分发边界

有权授权的原创部分采用 [Apache License 2.0](LICENSE)，既有 MIT 声明保留在 [licenses/WS-LEGACY-MIT.txt](licenses/WS-LEGACY-MIT.txt)。第三方代码、字体/资源及依赖保留各自许可，见 [NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不能把整个目录都视为 Apache-2.0。

可选 QQ 的 QCE 为 GPL-3.0，NapCat 另有含非商业限制的许可；`runtime` 不纳入源码仓库。现有本地便携目录不能直接作为公开发行包，分发前须按 [许可审查](docs/LICENSE_REVIEW.md) 和隐私流程另行核查。源码仓库：[https://github.com/Eris-Floralia-DyC2/gugugaga](https://github.com/Eris-Floralia-DyC2/gugugaga)。
