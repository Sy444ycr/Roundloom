# 后端运行与实现记录

日期：2026-11-13｜阶段：已按用户要求开始后端实现，桌面界面暂缓

## 运行

要求 Node.js 24 或更高版本。首次执行 `npm ci`，随后：

```powershell
npm run typecheck
npm test
npm run demo
npm run build
npm start
```

demo 使用内存数据库和两个模拟成员，完成求助、回复、续接、产物提交及用户验收，不调用付费模型。start 启动独立 Core，默认数据目录是当前目录下 `.roundloom`；通过 ROUNDLOOM_DATA_DIR 指定持久目录。

Core 支持三种宿主传输：Electron utility process 的 parentPort、Node child_process IPC，以及交互调试用 JSONL stdin/stdout。没有公开 HTTP 服务。只允许可信本地父进程调用；未来 Electron Main 必须校验窗口来源。本次未验证 Electron 打包及 ABI，不能把 Node 下测试通过视为桌面验收通过。

## 调用协议

每条命令包含 protocolVersion=1、requestId、operation 和 payload；成功返回同 requestId 的 ok/data，失败返回 code/message。

```json
{"protocolVersion":1,"requestId":"create-room-1","operation":"rooms.create","payload":{"name":"项目群"}}
```

命令运行时 schema 位于 packages/contracts/src/index.ts。可用操作：

| 分组 | 操作 |
| --- | --- |
| 群与成员 | rooms.create/list/pause/snapshot；members.add/list |
| 消息 | messages.send/list，无接收者只存记录 |
| 任务 | tasks.assign/get/list/update/handoff/cancel/retry/continue/accept/reject |
| 执行与产物 | runs.list、宿主 runs.reconcile、artifacts.list |
| 历史与推送 | events.read；宿主 events.subscribe/ack/unsubscribe |

修改任务必须携带 expectedVersion；tasks.accept 还需 artifactId 和 requirementsVersion。tasks.continue 用于用户处理等待状态，可提高 maxRuns，但不会绕过活跃或未知执行。读取任务获取最新 version 后再提交修改。

写命令在单用户 Core 内按 requestId 幂等；同 ID 不同负载返回 CONFLICT。作用域比设计中的 actor/room 更严格：同一 Core 全局唯一。读命令不缓存旧快照。命令、状态事件与派发记录同事务保存；适配器提交在事务之后执行。

事件订阅 payload 为 roomId、after；subscriptionId 使用订阅请求 ID。每批最多 100 个事件，客户端用 events.ack 提交 subscriptionId 与该批最后 sequence 后才推下一批；最多 64 个订阅。未确认期间历史保留在数据库，内存不积压事件队列。断连后用已应用游标重新订阅。窗口销毁时应 unsubscribe。

## 已实现与验证范围

- 独立成员/平台会话、定向消息、显式任务及可追溯运行。
- SQLite WAL、FULL 同步、版本 1 初始化；当前通过按 kind 分类的 JSON 对象表存实体，事件、幂等、派发和原生事件去重使用独立表及约束。不同实体关系由 Core 校验，尚未采用设计中全部独立实体表。
- 单会话活跃执行互斥，暂停、取消意图、预算、要求版本、空闲交接、重试和人工验收。
- 单待答请求、身份绑定求助工具、提前回复缓冲、超时与取消后禁止续接。
- 持久化事件、确认式流式推送、进程重启后将未决运行置为 unknown；仅适配器查询得到明确终态时核对。没有擅自重放或“强制成功”入口。
- 文本产物与 SHA-256 摘要绑定执行及要求版本，证据状态固定 unverified，模拟数据带 simulated。

## 适配器

### mock

仅用于测试，配置支持 delayMs、fail、hang、peerId、response。输出和产物均标记模拟，不能证明第三方 Agent 兼容。

### structured-cli

真实启动一个子进程，但要求其实现 Roundloom JSONL 桥接协议；不是把任意品牌 CLI 命令填进来就能使用。配置是绝对 executable、args 数组、绝对 cwd，shell=false，不允许任意环境变量注入；由可信用户配置可执行程序。此配置授予该程序本地执行能力，不是沙箱。

输入第一条为 run.start，包括 protocolVersion、runId、平台 sessionId、input、contextManifest、purpose 及 peerRequestId。当前任务的目标、条件与版本以 contextManifest 为准，triggerInput 是历史触发上下文。

允许输出：output/text、result/content、state（succeeded/failed/cancelled）、peer.request（callId/recipientId/question）、peer.reply（callId/requestId/text）。工具响应为 tool.result；同 callId 同负载只执行一次。主动求助后，桥接程序应结束该轮；回复到达后平台开启新一轮。

取消发送 run.cancel，只有桥接程序确认终态才视为停止；退出码 0 或 stdout 关闭不构成成功证据。缺少终态、非法或过大消息标为失败。stderr 不进入公开事件以避免泄密。退出时释放直属桥接进程，不保证清理任意后代进程或撤销文件修改。

此桥接器不提供原生恢复、认证管理或完整 SDK 会话管理。每轮启动新进程；平台 sessionId 仅为关联标识，跨轮私有记忆需桥接程序明确实现，不声称已恢复。

## 测试记录

当前测试覆盖幂等冲突、路由和跨群拒绝、版本验收、会话互斥、求助续接、取消、暂停、要求变更、事件去重、预算、SQLite 恢复、事务回滚、输入校验、提前回复成功/失败竞态、交接、重试、真实夹具子进程，以及 Core SIGKILL 后重启恢复。所有样例数据位于内存或独立临时目录。

真实子进程夹具只验证桥接机制，不是商业 Agent 集成测试。测试命令及结果以本次实际运行记录为准；没有付费模型调用、兼容性成绩或桌面安装验证。

## 后续边界

后端核心已可运行，但以下仍属于后续实现：真实厂商 ACP/SDK 适配器、完整连接鉴权和原生交互审批、Git worktree 与文件产物管理、真实测试证据采集、数据备份与保留策略、跨平台进程树清理、Electron Main 的单实例与安全边界、安装包验证。当前 Store 仅支持 schema v1 初始化和拒绝更高版本，尚无后续迁移。

这些缺口不能用 mock 或 JSONL 夹具结果代替；完整产品里程碑仍按原验收计划推进。

## 本轮更新

上一轮缺口已继续实现：工作区、Git worktree、真实命令测试、文件产物和证据核验、ACP 连接/认证/会话与权限请求、备份恢复、事件保留和数据库进程锁。当前 24 项测试通过，OpenCode 1.18.14 已完成真实 ACP 最小问答。最新能力和剩余兼容边界见[后端扩展交付记录](14-backend-delivery.md)，本页前面的旧缺口列表不代表最新状态。
