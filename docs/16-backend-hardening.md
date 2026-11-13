# 后端恢复与生命周期加固

2026-11-13。本记录接续 [原生接入交付](15-native-agent-integration.md)，描述后端运行可靠性补充，不代表桌面安装包交付。

## 异步请求与关闭

同一 requestId、同一负载在异步操作进行中重试，会等待原操作并返回相同结果。已完成请求返回持久化结果；相同 ID 改负载仍冲突。只有进程重启后遗留的 pending 记录才按执行结果未知处理，不盲目重做外部副作用。修复前在内存中仍运行的操作会被数据库 pending 标记遮蔽，错误返回 STATE_UNKNOWN。

Services 进入关闭后拒绝新操作并等待已有写操作；Core 的并发关闭请求共享一个关闭过程，避免重复关闭 SQLite 和适配器。

## ACP 生命周期

- 同一个会话并发连接共享一次初始化；初始化中的进程也受关闭管理。
- 旧进程退出回调只删除属于自己的连接，不会误删随后创建的连接。
- 在握手或创建/加载会话期间取消，后续不会继续发送 prompt。没有提交执行输入时可确认 cancelled；已经提交的运行仍依据原生终态判断。
- prompt 超时返回 unknown / provider_timeout，关闭对应传输并终止本地进程，不再复用可能仍执行旧输入的连接。远端副作用是否停止仍需核对。
- dispose 后不再接受连接或运行，等待初始化清理，避免后端关闭后又建立进程。

ACP config 在 executable、args、cwd 之外支持：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| timeoutMs | 120000 | prompt 等待上限，范围 1000–600000 毫秒 |
| resumeSessions | true | 新进程优先加载已保存的原生会话 |

初始化上限 15 秒，session/new 与 session/load 上限 30 秒；身份认证仍为 120 秒。

## ACP 原生恢复

适配器现在支持 session/load，resume=true 表示具备恢复协议实现，具体 Agent 必须在 initialize 声明 loadSession。Core 保存原生 ID 后，新进程加载该 ID 再发送下一轮输入；加载期间收到的历史输出不重复写入消息记录。

原生 ID 存在但 Agent 不支持 loadSession 时，适配器拒绝恢复，不会静默创建空白会话。需要全新上下文时，明确新建成员，或配置 resumeSessions=false；后者只关闭新进程的自动加载，当前进程内仍复用会话。未知的旧运行不自动重新提交。

OpenCode 1.18.14 真实验证：第一轮记住随机标记；关闭 Core 与 ACP 子进程后，重新打开数据库，第二轮正确返回该标记。两轮 status=succeeded，原生 ID 已保存，脚本退出码 0。流式回复按本轮消息片段拼接校验，避免标记被分片造成误报。

```powershell
npm run build
node dist/scripts/live-native.js acp PATH_TO_OPENCODE_EXE --pure acp
```

## 前端连接状态

connecting、connected、failed、disconnected 的显式操作均产生 connection.changed 事件。重启时已有 connecting/connected 记录变为 unknown，前端应重新连接确认，不能把磁盘中的旧状态视为当前在线。该记录是连接操作状态，不是实时心跳监控；Agent 空闲时主动退出的即时在线探测仍未提供。

## 验证结果

39 项自动化测试通过，格式检查通过。新增测试覆盖并发异步重试、关闭后拒绝请求、连接状态恢复、重复关闭、并发 ACP 初始化、握手期间关闭、创建会话期间取消、prompt 超时、重启加载与历史去重、不支持恢复时拒绝，以及显式选择新会话。

真实验证限于上述 OpenCode 环境。Codex 主动同伴工具、更多厂商差异、长期负载测试及桌面界面仍需独立验证。
