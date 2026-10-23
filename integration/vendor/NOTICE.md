# Source acknowledgements

## WS integration modifications

The existing local components are adapted into the WS worker. WS adds persistent snapshot/cache leases and LRU, normalized message storage, bounded document/image parsers, separate MCP/AI rules and protected task imports. Image scanner logging is suppressed; full-image validation and DPAPI storage replace raw-key output. No standalone Web monitor is launched. The Feishu client is reused from the user's existing feishu-group-intelligence connector with WS-owned DPAPI token storage. Original acknowledgements follow.

- Database format/key validation and WeChat 4 message-layout research: [328336690/wechat-decrypt](https://github.com/328336690/wechat-decrypt), MIT. License retained in `UPSTREAM-LICENSE.txt`.
- WeChat 4.1 Config.Cipher key-cache layout and XOR-decoding compatibility: [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica), Apache-2.0. License retained in `COMPAT-LICENSE.txt`. Adapted into a bounded, read-only scanner; cache persistence changed to Windows DPAPI, output restricted to verified database keys for the configured local account. No GUI activation, process-writing, sending, or other automation modules are used.
- WS task API extends the user's existing local WS project. The importer reuses that project's task schema, backup, atomic write and refresh behavior.

This package adds its own local setup UI, MCP allowlist, page/WAL validation, scheduling, proposal checks, durable outbox, and WS import adapter. Upstream source references are listed above. The current WS worker does not dynamically download or execute source code from those repositories; no local ASR model is used.
