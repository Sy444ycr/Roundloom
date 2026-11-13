# Agent 适配器接口细化

日期：2026-11-13｜状态：接口设计方向已确认（C-11）；字段 schema 与版本待实现阶段固化，尚无适配器实现或兼容性结论

## 1. 注册与连接

AdapterManifest 包含 adapterId、adapterVersion、contractVersion、configSchema、transports、authModes 和能力探测入口。配置分为普通字段与 secretRef；启动配置使用 executable、args 数组、cwd、允许的 env 字段，不拼接任意 shell 字符串。需要 shell 包装的产品由专用适配器明确实现并验证。

一个插件可创建多个 Connection；能力快照属于具体连接及版本，不能仅按品牌缓存。首版加载随应用发布的可信适配器；动态下载执行第三方插件不属于首版契约。

## 2. 操作契约

所有操作携带 operationId、connectionId，按需要补 sessionId/runId。方法名是平台内部语义，不代表原生协议存在同名接口。

| 操作 | 输入 | 结果与关键约束 |
| --- | --- | --- |
| probe | 配置、实现版本 | 配置有效性、协议范围、初步能力；不创建编码任务 |
| connect | 配置和凭据引用 | connected、auth_required 或失败；可用能力快照 |
| createSession | memberId、workspaceRef、工具绑定 | 原生引用、有效能力；声明是否需要独立连接 |
| startRun | 平台 runId、sessionRef、输入、contextManifest、requestId | accepted/rejected/unknown；accepted 不表示完成 |
| answerInteraction | 原生交互 ID、对应 Run、允许的响应 | accepted/rejected/expired；不能继承过期批准 |
| requestCancel | runRef、原因 | requested/already_terminal/unsupported/unknown；终态另由证据确认 |
| queryRun | 原生引用 | 观察到的状态及证据；unsupported 与 unknown 分开 |
| resumeSession | 原生引用、可用游标 | resumed/new_session_required/unsupported；不能静默新建 |
| fetchArtifact | 远端引用、授权的接收位置 | 获取状态、摘要、大小；不自动执行或合并 |
| disconnect | 连接引用 | 关闭本地连接结果；不暗示远端停止 |

Core 在调用 startRun 前建立运行记录和事件归属。原生输出可能先于 accepted 应答到达，适配器必须使用平台 runId 归属并按序交付。订阅通道应在提交前准备就绪。调用超时不等于取消，提交结果不明返回 unknown 并进入核对。

核心控制消息不排在普通输入队列之后；取消和审批必须可以在活跃运行期间送达。适配器不得自行无限重试写操作。

## 3. 统一事件

事件类型至少包括 connection.changed、session.created、content.delta、content.replaced、interaction.requested、run.state_changed、artifact.reported、usage.reported 和 adapter.error。

事件包含连接、会话、平台运行、原生引用、发生时间、原生事件 ID 或适配器流序号。Core 分配平台 eventId 和房间序号。内容事件带 blockId 与增量/替换语义；工具输入、输出与普通文本分开。断流只报告连接状态，不合成成功终态。

标准输出如用于结构化协议，诊断日志走标准错误或独立通道。非法事件进入脱敏诊断并阻塞受影响运行的自动完成，不能通过解析可读文字猜测成功。

## 4. 能力与接入等级

每项能力由状态、证据级别、限制、验证版本与日期组成。证据级别依次为文档、握手、实测；未实测须在界面保留该区别。

| 接入等级 | 必要能力 | 可用范围 |
| --- | --- | --- |
| 咨询成员 | 输入、结果输出、可关联运行 | 定向讨论与咨询 |
| 执行成员 | 咨询能力，加真实工具/工作区及产物证据 | 代码任务，按实际能力提供审批和停止 |
| 协作成员 | 上述适用能力，加受身份约束的工具调用及回复关联 | 主动同伴求助、等待与后续轮次 |

等级是界面归纳，实际路由仍逐项查能力。续接、流式、取消、用量和审批分别声明，不能由等级推导。不支持恢复时，只有显式建立新会话并标注上下文交接，才可继续下一次执行。

ACP v1 创建会话需提供 cwd 和 MCP servers 配置，加载历史受 loadSession 能力约束。因此平台层 workspaceRef 可空不意味着 ACP 路径可以省略 cwd；适配器需要经过授权的目录或返回配置缺失，不能自行回退到用户主目录。参见 [ACP 会话规范](https://agentclientprotocol.com/protocol/v1/session-setup)。

## 5. 群聊工具入口

建议首版工具为 room.readMessages、room.sendMessage、task.read、peer.request、peer.reply 和 task.submitResult。submitResult 只能提交候选，不能设置 completed。普通 sendMessage 不自动成为任务，也不替代带关联 ID 的 peer.request。

工具身份由绑定的 Connection、Member、Session、Run 和 roomId 推导；凭证只允许该运行作用域，生命周期结束后撤销。不得接受模型覆盖发送者。工具请求走与界面命令相同的核心校验和事务，不走 Renderer 或单独写数据库。

工具传输可由 MCP stdio 桥接或本地受认证端点实现，按 Agent 能力选择。Agent 可能不继承 Electron IPC，因此不得假定外部 CLI 能直接调用 preload。Core 重启后旧工具凭证失效，恢复连接需重新绑定；是否允许动态绑定由适配器声明，不支持时显示恢复限制。

## 6. 兼容验证与扩展出口

每个实现跑配置校验、双实例隔离、输出归属、重复事件、错误终态、取消、交互过期、恢复限制和凭据脱敏用例；不支持的能力记录为不适用及原因，不能记为通过。

新增适配器的验收：实现 manifest 与操作契约、通过适用契约测试、更新能力矩阵、提供独立样例证据；不得修改群聊或任务核心增加厂商分支。配置接入只能复用已支持的协议，任意命令不能自动成为合格适配器。

协议、SDK 和运行时版本在首批对象选定后锁定。本文件不承诺具体品牌已经兼容，亦不安装或连接真实 Agent。

