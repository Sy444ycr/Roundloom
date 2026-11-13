# Codex 主动求助与持续负载验证

## Codex 同伴工具

Codex 的 peerMessaging 现在为 true。每个 Run 创建独立的 MCP Streamable HTTP 服务，仅监听 127.0.0.1 的系统分配端口。256 位随机 bearer token 只传入本次 Codex 子进程环境，不写入成员配置、运行记录或项目配置文件。工具调用固定绑定该 Run 的 RunTools，输入只有接收者、问题或回复内容，不能指定发送者身份。

公开的三个工具为 members、peer_request、peer_reply。Core 继续校验房间、负责人、任务状态、请求归属和轮次预算；MCP 输入严格校验，拒绝额外身份字段。HTTP 请求体上限 150000 字节，拒绝未鉴权请求及带 Origin 的浏览器请求。取消、超时、终态及 dispose 都会关闭本次接口，旧凭据不能调用后续运行的工具。该端点不提供文件、命令或任意 Core API；它不是多用户隔离边界，同一系统账号的其他进程仍属于本机信任范围。

仅 roundloom 内部工具设为自动允许，作为已授权任务协作的一部分；Codex 默认只读沙箱、网络和网页搜索设置不变。连接为 required，连接失败时不能假装具备协作工具。实现依据 [官方 Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，通过 SDK 的单次配置覆盖注入，不修改用户的全局 config.toml。

真实验证：Codex 使用 peer_request 主动向 OpenCode 求助，OpenCode 通过 ACP 返回答案，Codex 原生会话续接后输出预期结果。一次 peer 请求、一次回复、一次续跑，三个 Run 均 succeeded，任务停在 review。Codex 回复求助现在使用显式 peer_reply，不再将普通最终文本当作工具回复。

```powershell
npm run build
node dist/scripts/live-collaboration.js - PATH_TO_OPENCODE_EXE --codex
```

真实模型验证使用本机认证，可能产生费用；默认 CI 不调用模型。

## 持续负载方法

```powershell
npm run test:soak -- 600
npm run test:mcp-soak -- 1000
```

Core 测试每 4 秒突发提交 8 个任务，同时重复提交每个 requestId。8 个负责人、1 个同伴和1个取消专用成员运行在同一个房间；部分任务主动求助，每 7 个任务安排一次运行中取消。测试持续读取事件、每 30 秒裁剪事件，中途排空队列后重启 Core，并检查同一会话不并行、任务没有重复、同伴只续跑一次、最终队列排空及 SQLite 完整性。

每 30 秒进行一次显式 GC 后记录 heap、RSS 和任务数量，记录任务 p95 延迟及事件循环 p99 延迟。预设失败阈值：任务 p95 ≥ 5 秒、事件循环 p99 ≥ 500 ms、预热后 heap 增长 ≥ 64 MiB、RSS ≥ 512 MiB、最终不能排空或任何状态不变量破坏。事件消费者通过数据库事件接口测试；IPC 背压由独立 host 集成测试覆盖，不能把该负载结果称为桌面界面吞吐量。

MCP 测试以 8 并发反复建立真实 HTTP 连接、鉴权、调用 peer_request、撤销并关闭接口，检查成功调用数、GC 后 heap 增长及遗留 TCP 监听句柄。它验证工具传输生命周期，不请求真实模型。

## 自动运行与证据

2026-11-13 实测（Windows，Node 24.16.0）：

| 指标 | 结果 |
| --- | --- |
| Core 持续时间 | 600.077 秒，通过 |
| 任务 | 1200 提交，1028 待验收，172 按计划取消，无重复任务 |
| 并发与恢复 | 最大同时活跃 8 个 Run，中途重启 1 次，最终排空 |
| 任务 p95 / 事件循环 p99 | 867 ms / 144.44 ms |
| GC 后 heap | 初次采样 9.46 MiB，最后采样 10.09 MiB |
| RSS 最后采样 / 数据库 | 226.91 MiB / 12943360 字节 |
| MCP 生命周期 | 8 并发，1000 次成功调用，6.679 秒 |
| MCP 回收 | heap 增长 6.71 MiB，遗留监听句柄 0 |

原始测量报告：[Core](verification/core-soak-2026-11-13.json)、[MCP](verification/mcp-soak-2026-11-13.json)。heap/RSS 是周期采样而非整个区间的绝对峰值；事件循环直方图是整个进程区间的观测。

常规 CI 包含 43 项测试、30 秒 Core 负载及 100 次 MCP 周期。独立的 Extended backend soak 工作流支持手动指定 60–3600 秒，默认一小时；报告作为 GitHub Actions artifact 保存。后续已完成本地一小时运行并修复历史查询性能问题，结果见 [一小时复测记录](18-hour-soak-and-scheduler-indexes.md)；GitHub 一小时手动工作流尚未执行。

本地报告和测试数据库保存在 .roundloom/soak、.roundloom/mcp-soak，默认不提交 Git。测量只代表当前 Windows / Node 24 环境下有界负载，不是多日稳定性、所有厂商并发或真实模型吞吐保证。数据库任务与幂等记录有意持久化，事件裁剪不等于数据库总量不增长。
