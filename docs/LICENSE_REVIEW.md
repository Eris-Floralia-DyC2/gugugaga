# 许可证与公开分发检查（2026-10-23）

根 LICENSE 是从 Apache 官方下载的完整英文 Apache-2.0 文本，未改条款或替换附录占位文字。package.json / lock 根元数据与 README 一致；这只涵盖有权授权的原创部分，不改变第三方许可。

## 来源与条件

| 范围                                                                           | 现有证据和处理                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS 原创源码/文档                                                               | 用户要求 Apache-2.0。原 LICENSE 的 MIT 声明保留于 licenses/WS-LEGACY-MIT.txt，未编造新版权人。不能撤销已经授出的 MIT 权利。                                                                                                     |
| integration/vendor/feishu_mcp/_、assets/_、test/fixtures 的三个图片            | 用户于本次审查明确确认本人原创或已获 Apache-2.0 公开分发授权。按该确认纳入原创/授权范围，未虚构作者姓名；维护者应保存真实授权凭证。                                                                                             |
| integration/vendor/wechat_reader.py、decode_image.py、find_image_key.py 等适配 | 既有 NOTICE 列出 wechat-decrypt MIT 来源及 Config.Cipher 的 Apache-2.0 兼容来源；保留 UPSTREAM-LICENSE.txt、COMPAT-LICENSE.txt 和修改说明，不统一改标。来源不是逐行原创性鉴定。                                                 |
| npm 运行依赖                                                                   | 按 package-lock 和实际安装包生成 THIRD_PARTY_NOTICES.md；AJV MIT、DOMPurify 选 Apache-2.0 分支、Koffi MIT，其余传递依赖逐项保留原文。开发依赖不自动进入运行包；Electron/Chromium 仍随应用分发。                                 |
| Electron/Chromium                                                              | 保留 Electron.LICENSE 和 LICENSES.chromium.html；不能用根 LICENSE 代替。                                                                                                                                                        |
| Python 与解析依赖                                                              | requirements-lock.txt 固定版本，打包时 scripts/python-notices.py 收集实际环境 METADATA/许可。certifi MPL-2.0、PyInstaller GPL 带打包例外等保留各自条件，不能只看包的 License 字段。                                             |
| QCE 6.3.2                                                                      | 独立程序，GPL-3.0；源码地址、固定版本源码归档及原许可在 QQ_THIRD_PARTY.md/runtime 中；公开二进制需核实对应源码和完整构建材料。HTTP 进程隔离不等于自动满足所有分发条件。                                                         |
| NapCat 随包组件                                                                | 本地 NapCat-LICENSE 与官方 Limited Redistribution License 一致，含非商业等限制，不可宣传为整个完整包 Apache-2.0 或无条件开源。源码仓库不纳入该 runtime；若计划公开含 QQ 的二进制包，先明确许可方案/获必要授权或提供不捆绑方案。 |
| 官方 QQ                                                                        | 用户本机安装后复制专用客户端，不进入源码/公开包；其软件许可与服务条款仍适用。                                                                                                                                                   |

## 尚未完成的公开前条件

本次是本地准备，不代表所有分发条件已经通过。旧便携目录混有联接、旧代码及历史产物，不能直接打 ZIP。含 QCE/NapCat 的完整二进制分发方案仍需维护者决定；这是该类完整包的公开阻塞项，不应混为原创源码的 Apache 条款冲突。

公开二进制前还应核对 Python 解释器/原生库的所有许可证、certifi/MPL 对应源码告知和上游来源、QCE 的完整对应源码是否充分，以及最终实际包的文件清单。包元数据是许可线索，不等同于完整法律审查；本地构建成功不证明分发合规。源码可先独立审阅，但实际 Git 暂存区仍需按最终文件逐项选择，不能直接发布旧暂存快照。

## 官方参考

- [Apache-2.0 官方英文文本](https://www.apache.org/licenses/LICENSE-2.0.txt)
- [PyInstaller 打包例外](https://pyinstaller.org/en/stable/license.html)
- [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [QCE v6.3.2 许可证](https://github.com/shuakami/qq-chat-exporter/blob/v6.3.2/LICENSE)
- [NapCat 许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)

第三方项目及权利人信息以各原始声明为准，WS 不授予额外权利。
