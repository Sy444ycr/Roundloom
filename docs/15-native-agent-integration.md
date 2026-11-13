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

Claude 注入 roundloom MCP 服务，提供 members、peer_request、peer_reply。工具绑定当前运行身份，Core 校验房间、任务与回复范围。内部协作工具自动允许，其余需要 SDK 请求授权的调用转为 permission interaction；SDK 自身的自动允许规则仍由原生运行时控制。

Codex 使用 approvalPolicy=never、禁用网络及 webSearch，默认只读沙箱，目前没有同伴 MCP 工具，peerMessaging=false。不得把 Claude 的同伴能力套用到 Codex 或 ACP。跨厂商真实协作仍需专项验收。

## 验证

2026-11-13，Windows / Node 24：28 项自动化测试通过，包括原生会话持久化、排队续接、数据库重启续接、权限拒绝、取消、失败和不完整事件流。默认 CI 使用可控 SDK 夹具，不调用收费模型。

Claude Code 2.1.281 真实联调通过：第一轮返回固定标记，关闭并重建 Core 后第二轮正确返回仅在上一轮出现的随机标记，两轮均收到原生成功终态。没有操作项目文件，不代表真实编码或跨 Agent 协作已验收。

Codex SDK 自带运行时及本机 codex-cli 0.147.0 的最小问答均在 60 秒内未完成；尚未定位到认证、服务连接或原生运行时的具体原因，不能标记真实接入通过。取消后临时数据库文件出现 Windows 占用；脚本报告并保留无法清理的目录，失败返回非零退出码。后续脚本已将 Core 数据目录与 Agent 工作目录分离。

手动复测（使用本机账号，可能产生费用）：

```powershell
npm run build
node dist/scripts/live-native.js claude PATH_TO_CLAUDE_EXE
node dist/scripts/live-native.js codex PATH_TO_CODEX_EXE
```

脚本只输出状态与校验结果，不输出认证信息。仍待完成：Codex 真实调用排障、真实跨 Agent 求助/恢复、真实工作区编码与产物验收联调。

参考：[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)。
