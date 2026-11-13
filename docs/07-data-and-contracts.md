# 数据与接口语义设计

版本：v0.2 评审草案｜日期：2026-11-13

本文固定建议的语义字段与约束，不固定数据库表、HTTP 路径或第三方协议版本。

## 1. 公共字段和关系

所有持久对象具有平台 ID、createdAt；可变对象有 updatedAt、version。时间以 UTC 保存，界面按用户时区显示。原生 ID 必须附 connectionId 和资源类型；凭据仅保存引用。

| 对象 | 必要字段或关系 |
| --- | --- |
| Member | roomId、connectionId、displayName、会话策略；用户成员可无连接 |
| Session | memberId、nativeRef、workspaceRef、恢复能力；共享原生会话使用同一执行锁键 |
| Message | roomId、senderMemberId、recipientMemberIds、kind、content、replyTo、taskId、requestId |
| Task | roomId、ownerMemberId、ownershipVersion、requirementsVersion、目标、验收条件、status、waitReason |
| Run | sessionId、triggerMessageId、taskId（可空）、nativeRef、status、cancelRequestedAt、attempt、上下文清单 |
| PeerRequest | taskId、请求/回复消息、接收者、deadline、lineageId、status |
| Artifact | runId、taskId、类型、获取引用、获取状态、内容摘要、基准和产物版本 |
| TestEvidence | runId、artifactVersion、命令、环境引用、起止时间、exitCode、日志引用、验证级别 |
| Acceptance | taskId、要求版本、产物版本、条件结论、actor、时间 |
| DispatchIntent | 来源请求、目标会话、状态、提交关联、重试信息 |

跨群引用默认禁止。回复必须关联存在且可访问的消息或请求。删除成员优先软停用，历史引用保留；运行中连接不能因删除配置失去追踪信息。日志和产物清理由独立保留策略处理。

## 2. 命令契约

创建任务、发消息、回复求助、取消、交接和验收均携带 clientRequestId；修改对象同时携带 expectedVersion。服务绑定 actor，不能信任客户端自报身份。

幂等键作用域为 actor + roomId + operation + clientRequestId。相同键和相同负载返回原结果；相同键但不同负载返回冲突。结果包括对象 ID、版本、接受状态或结构化错误。接受仅表示平台持久化成功，不代表 Agent 已执行。

任务、来源消息、事件和派发意图在同一事务保存。调度器消费派发意图时记录提交阶段；外部提交结果不明时标为待核对，不能按普通网络重试盲目重发。

错误分类至少包含 VALIDATION、NOT_FOUND、FORBIDDEN、CONFLICT、CAPABILITY_UNSUPPORTED、AUTH_REQUIRED、BUDGET_EXCEEDED、PROVIDER_UNAVAILABLE、STATE_UNKNOWN。错误含可读说明、关联 ID、是否可重试及建议动作；不得附原始凭据。

## 3. 事件信封与恢复

事件信封包含 eventId、roomId、roomSequence、type、schemaVersion、occurredAt、recordedAt、source、相关对象 ID、payload；可选 nativeEventId 和原生游标。roomSequence 是房间内单调序号，不承诺跨房间全序。

客户端按房间游标补齐；重复 eventId 不重复应用。没有原生事件 ID 时，适配器需声明可用去重策略及局限，不得按文本相同直接删除合法输出。增量输出需标明追加或替换语义及所属内容块。

游标过期时返回明确错误，客户端获取状态快照和对应水位，再继续订阅；快照与水位必须一致。未知 schemaVersion 不静默丢弃，保留原事件并提示兼容错误。

## 4. 实施前应落地的产物

进入对应模块开发时，将本文转换为有版本的数据 schema、接口定义和适配器契约测试；明确可空字段、大小限制、索引、事务边界及迁移策略。破坏性变更需要迁移与恢复说明，不以本草案代替完整接口定义。
