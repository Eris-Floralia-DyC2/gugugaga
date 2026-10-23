# QQ 第三方资源及许可证

唯一采集运行资源是 [QQ Chat Exporter 6.3.2 官方 Shell 包](https://github.com/shuakami/qq-chat-exporter/releases/tag/v6.3.2)。原文件 NapCat-QCE-Windows-x64-v6.3.2.zip 未修改，SHA256 为 3fc093ba2332b97ac17e16160d5baa6ffe0a8def6c394d515a94777fe0ca492c，发行包中名为 runtime/qce-shell-v6.3.2.zip。

QCE 使用 GPL-3.0，全文保留在 runtime/QCE-LICENSE。对应 v6.3.2 官方源码（提交 7d154b847a0cb3f9cffbdb126598c4d1434995ba）保存在 runtime/QCE-6.3.2-source.zip；[上游源码及构建说明](https://github.com/shuakami/qq-chat-exporter/tree/v6.3.2)。WS 通过独立进程的本机 HTTP API 调用，未修改 QCE 二进制。

官方 Shell 包包含 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)，版权 © 2024 Mlikiowa，适用其 Limited Redistribution License，不等同 MIT 或无限制商业许可。完整许可证在 runtime/NapCat-LICENSE.txt；许可证限制商业使用，并要求保留许可、来源和版权信息。本文及本地个人交付不授予额外的公开发布、商用或修改后公开发行权利；未来正式分发应另核对该许可证、对应组件和上游发布条件。

官方资源内还包含其原有许可证及第三方通知。腾讯 QQ 安装程序不随 WS 分发，首次配置仅从用户已安装版本复制专用本地副本；QQ 的许可和服务条款仍适用。第三方登录可能受版本变动或账号风控影响。

WS 有权授权的原创部分拟采用 Apache-2.0；原 MIT 声明保留在 licenses/WS-LEGACY-MIT.txt。Electron/Chromium、npm、Python、QCE 和 NapCat 的许可继续独立保留，根 LICENSE 不替代它们。公开前未决事项见 LICENSE_REVIEW.md。
