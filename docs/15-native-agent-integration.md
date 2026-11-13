# 原生 Agent 接入交付

## 接入方式

Core host 注册 `claude` 和 `codex` 两个适配器，分别使用官方 Claude Agent SDK 与 Codex TypeScript SDK。依赖由 package-lock.json 固定，运行时使用本机 Agent 环境和认证，不需要用户向聊天发送密钥。

通过 `members.add` 指定 adapterId，config 示例：

```json
{ "cwd": "C:/work/project" }
```

cwd 必须是现有目录。可选 model 指定模型，executable 指定真实可执行文件（不能传 PowerShell 包装脚本）。Claude 支持 maxTurns（默认 6，上限 30）、maxBudgetUsd（默认 1，上限 20）；Codex 支持 sandboxMode（默认 read-only，可选 workspace-write）。配置限制只对对应 SDK 生效，不是跨厂商统一费用上限。

## 会话与执行状态

原生 session/thread ID 通过 session 事件写入 SQLite。排队运行在派发时获取最新 ID；后端重启后通过原生 resume 续接已存在会话。此能力依赖原生会话文件仍存在，不代表中断运行可以自动重放；中断运行仍标记 unknown，等待核对。

只有明确成功终态才生成任务文本产物；事件流结束但没有成功终态标记 unknown。开始新一轮任务会清除上一轮候选产物引用，避免旧回答作为新交付被验收。取消转发 AbortSignal；关闭后端等待适配器释放资源，原生 SDK 最多等待 5 秒，超时不能保证远端执行已停止。

## 权限与协作边界

原生适配器支持 timeoutMs（默认 120000，范围 1000–600000）。超时标记 unknown，原因是 provider_timeout 或已捕获的 provider_connection_failed，不伪造成功或已取消。Codex 的重连 error 事件不是终态；收到 turn.completed / turn.failed 后立即关闭事件迭代器，避免等待 CLI 退出导致已完成的请求被超时覆盖。原因码不会包含原始服务错误、URL 或认证材料。

Claude 注入 roundloom MCP 服务，提供 members、peer_request、peer_reply。工具绑定当前运行身份，Core 校验房间、任务与回复范围。内部协作工具自动允许，其余需要 SDK 请求授权的调用转为 permission interaction；SDK 自身的自动允许规则仍由原生运行时控制。

Codex 使用 approvalPolicy=never、禁用网络及 webSearch，默认只读沙箱。后续已增加 Codex 的显式 MCP 同伴工具，见 [主动求助与负载验证](17-codex-peer-and-soak.md)。ACP 仍不提供主动求助工具，只把明确关联 peerRequestId 的成功最终回答交回请求者；Core 校验运行身份、房间和接收者。

## 验证

2026-11-13，Windows / Node 24：31 项自动化测试通过，包括原生会话持久化、排队续接、数据库重启续接、权限拒绝、取消、失败和不完整事件流、成功终态关闭迭代器、超时原因脱敏、ACP 定向回复及过期工具作用域。默认 CI 使用可控 SDK 夹具，不调用收费模型。

Claude Code 2.1.281 与 Codex SDK 默认运行时均通过真实两轮问答：第一轮返回固定标记，关闭并重建 Core 后第二轮正确返回仅在上一轮出现的随机标记，两轮均收到原生成功终态。SDK 版本锁定在 package-lock.json；此结论不外推到所有已安装的 Codex CLI 版本。

此前 Codex 超时排障观测到连接重置（Windows 10054）、多次重连，以及 turn.completed 后仍等待进程结束。修正终态消费并将测试工作区与数据库目录分离后，默认运行时的两轮实测成功，清理正常；不声称已消除所有网络故障或原生运行时问题。

Claude → OpenCode 1.18.14 → Claude 的真实协作通过：记录一次求助与回复，负责人只续跑一次，三个 Run 均成功。编码模式中 Claude 使用 Write 在隔离目录生成 add.mjs，独立 Node 测试覆盖正数、负数、零、小数，结果 passed；文件产物核验 verified，任务保持 review，仍须用户验收。该场景证明最小编码闭环，不代表大型项目质量或性能验收。

保存证据的编码实测中出现一次临时工作目录仍被占用，脚本如实以非零退出。随后修正 ACP 关闭逻辑：Windows 终止所拥有的进程树并等待退出，Core 等待所有适配器释放。独立使用真实 OpenCode 连接后关闭的复测确认临时目录可删除。编码证据保存在本地 .roundloom/live-evidence/724d97ce-de83-4e6a-9a01-2c06ef90498e，包含退出码 0、产物摘要和完整数据库快照；目录清理结果与业务测试结果分别记录。

手动复测（使用本机账号，可能产生费用）：

```powershell
npm run build
node dist/scripts/live-native.js claude PATH_TO_CLAUDE_EXE
node dist/scripts/live-native.js codex PATH_TO_CODEX_EXE
node dist/scripts/live-collaboration.js PATH_TO_CLAUDE_EXE PATH_TO_OPENCODE_EXE --coding
```

脚本只输出状态与校验结果，不输出认证信息。编码脚本只批准目标临时文件的 Write 请求；通过后在 .roundloom/live-evidence 下保存生成代码、SQLite 快照和包含命令、退出码、摘要及产物的报告，默认不提交 Git。测试数据中的原始工作区路径随清理失效，证据用于审计，不能直接当作仍可编辑的工作区恢复。

当前可用于桌面前端对接的后端预览。ACP 原生跨进程恢复见 [后端加固记录](16-backend-hardening.md)，Codex 主动同伴工具见 [主动求助与负载验证](17-codex-peer-and-soak.md)。更多厂商与复杂真实工程场景仍需扩展；桌面界面与安装包另行交付。

参考：[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)。
