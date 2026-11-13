# 后端扩展交付与兼容记录

日期：2026-11-13。本文更新 13 文档中上一轮的缺口列表；以当前源码与测试为准。

## 当前可用能力

在原消息、任务、调度和事件后端之外，已实现：

| 能力 | 入口与行为 |
| --- | --- |
| 连接与认证 | adapters.list、members.connect/authenticate/disconnect、connections.list、sessions.list |
| ACP v1 | 官方 SDK；握手、认证方法、原生会话创建与进程内多轮复用、输出、取消、权限回调 |
| 权限审批 | interactions.list/answer；请求绑定 Run，可选项校验、超时取消、运行结束撤销、重启失效 |
| 工作区 | workspaces.register/list/read/write/snapshot；路径范围校验、符号链接限制、文件摘要 |
| Git 工作树 | workspaces.worktree；校验 Git revision 后创建独立 detached worktree，不修改原工作树 |
| 真实测试 | tests.execute/cancel/list；真实子进程、超时、进程树取消、起止时间、退出码、限长日志、前后快照 |
| 文件产物 | artifacts.capture/inspect；文件清单、内容摘要、要求版本；匹配真实测试证据后展示 verified |
| 验收保护 | 服务层 tasks.accept 重新核对文件摘要；文件变化后拒绝沿用旧版本验收 |
| 数据维护 | storage.backup、一致性数据库备份、离线恢复到新路径、events.prune 保留最近事件 |
| 恢复保护 | 数据库进程锁；遗留运行与未完成测试置为 unknown；异步副作用请求保留提交标记防止盲目重试 |

所有这些入口由独立 Core host 提供，Electron Main 后续可直接通过 parentPort 调用。异步服务请求并发处理，不让执行中的测试或连接请求阻塞取消和审批回复；数据库操作仍由单 Core 完成。

## 工作区到测试验收的调用顺序

1. 建群、添加成员和分配任务。
2. workspaces.register 登记项目目录，或 workspaces.worktree 创建独立工作树。
3. Agent 执行结束后，通过 tests.execute 指定 taskId、workspaceId、executable、args、timeoutMs。真实命令使用参数数组，shell=false。
4. tests.list 查看证据。命令失败为 failed；前后文件摘要或要求版本改变为 stale；无法确认退出为 unknown。
5. artifacts.capture 携带 taskId、workspaceId、expectedVersion，捕获交付候选。该操作取消尚未开始的旧派发，避免待验收后又执行旧工作。
6. artifacts.inspect 动态核对当前文件、要求版本和通过的证据。tasks.accept 由用户确认功能条件；测试通过不自动完成任务。

测试和产物捕获期间持有任务调度锁，阻止相同任务被自动派发。工作区不是安全沙箱：显式执行的程序仍拥有当前用户权限。快照最多 10,000 个文件、100 MB，跳过 .git/node_modules/.roundloom，遇到符号链接拒绝捕获；依赖环境变化不能仅靠源码摘要识别。测试日志最多保存约 1 MB。

## 实际验证结果

本节记录基础后端交付时的验证。后续原生适配、28 项测试及真实续接结果见 [原生 Agent 接入](15-native-agent-integration.md)。

环境：Windows x64，Node.js 24.16.0，TypeScript 5.9.3，better-sqlite3 12.11.1，ACP SDK 2.6.0。版本由 package-lock.json 固定。

`npm test`：24 项集成测试通过。覆盖原 19 项，以及真实命令证据、执行中取消、ACP 权限/认证/会话、数据库进程锁与事件裁剪、Git worktree 与备份恢复。`npm run format:check` 校验代码格式。测试在临时目录和夹具上运行，没有使用用户项目作为写入目标。

真实安装探测与联调：

| Agent | 本机版本 | 结果 |
| --- | --- | --- |
| OpenCode | 1.18.14 | ACP 握手成功；隔离临时目录内完成一次真实问答，收到 ROUNDLOOM_OK，运行 succeeded |
| Claude Code | 2.1.281 | 已检测安装与版本；尚未实现并验证其专用接入路径 |
| Codex CLI | 0.147.0 | 已检测安装与版本；尚未实现并验证其专用接入路径 |

OpenCode 实测只包含无工具的最小问答，不等于真实编码、原生恢复或跨厂商协作验收。脚本位于 scripts/live-acp.ts；通过参数提供本地可执行程序及 ACP 参数，测试结束清理隔离目录，不输出密钥。OpenCode 官方说明其 `acp` 子命令使用已有认证配置，协议为 stdio ACP：[OpenCode ACP 文档](https://opencode.ai/docs/cli/acp/)。

## ACP 能力边界

使用 SDK 的稳定 v1 入口。只声明已实现的客户端能力，未声明客户端文件服务、终端服务或 MCP 工具。Agent 自带执行工具仍由 Agent 负责。Roundloom 的审批回调可以转交用户，但不会伪造原生授权。ACP 适配器当前 peerMessaging=false；JSONL 桥接具备同伴工具，不能把两者的能力混为一谈。

当前支持进程存活期间原生会话复用。Core 重启后保持 unknown 并要求核对，不声称实现原生 session/load。断流报告 unknown，不把进程失联转换为成功。完整恢复、更多协议能力及其他品牌适配器继续按兼容矩阵扩展。

## 备份、恢复和保留

storage.backup 将一致性数据库快照写入数据目录 backups，包含消息、任务、文本产物、文件清单和测试记录；不复制外部 Git 工作树及用户项目文件。

```powershell
npm run build
node dist/scripts/restore.js BACKUP_FILE NEW_DATABASE_PATH
```

恢复先检查 SQLite 完整性和 schema 版本，只写入不存在的新数据库路径，不覆盖现有数据。将 ROUNDLOOM_DATA_DIR 指向该新数据库所在目录（文件名使用 core.db）后启动。外部工作区需用户自行备份并恢复到对应路径。

events.prune 接收 roomId 和 keepLast（至少保留 1 条）。历史游标被裁剪后返回 CURSOR_EXPIRED；推送订阅收到 events.resync_required，客户端必须读 rooms.snapshot 获取水位再订阅。事件裁剪不删除任务、产物或幂等记录。

## 前端对接前仍需注意

公开桌面入口必须使用 host/Services 路径，尤其是包含文件产物的 tasks.accept，不能绕过异步文件核验直接调用底层 Core.execute。Main 仍需完成窗口来源校验、单实例 UX、安装与打包测试。后端不开放公网端口，也没有多用户认证模型。

现有 schema 为 v1；更高版本拒绝写入。未来数据库结构变化需要增加迁移，当前不存在虚构的迁移版本。真实品牌接入与安装包的剩余工作，不影响已交付后端 API 的本地使用，但不应描述为“全部主流 Agent 已兼容”。
