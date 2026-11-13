# 连接健康探测与长期历史归档

日期：2026-11-13。本文替代 16、19 文档中相应未实现项。

## 连接健康

Core 启动后每 5 秒执行一次不阻塞的本地探测，也可通过 `connections.check { roomId }` 立即检查。返回连接记录中的 `health.state`、`health.scope` 和 `health.checkedAt`；只有状态或探测范围改变时发布 connection.changed，不为每次心跳生成重复事件。Core 关闭时停止定时器。

- ACP：确认握手已完成、子进程尚未退出、RPC/输入输出流未关闭。范围为 local-transport。空闲退出或断流会更新 disconnected；重新连接成功恢复 connected。由实际任务自动建立的 ACP 连接也会被发现。
- 原生 SDK、JSONL 和模拟适配器未提供持续连接探测时，明确返回 unknown / unsupported，不启动探测用模型请求，也不把连接配置可用等同于厂商服务在线。
- 适配器可实现可选的同步 `health(sessionId)` 接口。其契约要求只读取本地状态，不能执行网络请求、启动进程或阻塞 Core。

本地进程存活不能证明模型 API、认证、额度或远端服务正常；实际运行的超时和失败仍由原有执行状态处理。健康掉线不把未知任务自动标成取消或成功，也不自动重放任务。

测试同时发现并修复了连接与原生会话共用存储 ID 的问题。连接记录现在使用 `connection:<sessionId>`，单独提供 sessionId 字段；会话记录仍使用原 sessionId，避免执行期间覆盖连接记录或续接引用。

## 历史归档 API

以下为 Services/host 操作，使用现有 protocolVersion=1、requestId、operation、payload 封装。

| operation | payload | 行为 |
| --- | --- | --- |
| history.archive | taskId、expectedVersion | 原子归档一个终结任务及关联历史 |
| history.list | roomId、limit（默认 50，最大 100）、offset（默认 0） | 按归档时间倒序分页列出摘要 |
| history.read | archiveId | 查看任务、运行、消息、同伴请求、产物、测试证据、验收及权限交互记录 |
| history.restore | archiveId | 原子恢复历史到日常列表，不自动执行任务 |

归档对象必须处于 completed、cancelled 或 failed，且所有 Run 已终结、派发已完成，没有待答同伴、运行中测试或待审批请求。review、waiting、unknown 和正在测试/捕获产物的任务会被拒绝。每次归档最多 50000 个对象、100 MB 对象数据和 100 MB 去重/派发元数据；超限不做部分移动。

这是同一 SQLite 数据库内的冷表归档：从日常任务、运行、消息等列表移出大段历史，原始 JSON 和相关派发、适配器事件去重记录均保留。归档与恢复的移动及 history.archived/history.restored 事件在单个事务中提交；中途出错整体回滚。普通读取仍可按 ID 找到旧对象，artifacts.list 和文件证据核验可以读取归档数据。修改或重新执行归档任务须先恢复；迟到的适配器事件不会复活已归档运行。

全局 requestId 幂等记录与房间事件流不删除，重复提交旧请求不会生成新的任务。现有 events.prune 独立管理事件保留。恢复保留原版本和终态；若要重试已取消或失败任务，恢复后再显式调用 tasks.retry。

此功能不自动按天数删除数据，不立即缩小整个数据库文件，不复制外部项目文件。它解决日常数据集随历史增长而膨胀的问题，数据库整体容量仍须监控。`storage.backup` 包含冷表；离线恢复脚本支持新旧数据库备份。外部工作区文件仍需单独备份。

## 数据库兼容与迁移

schema 从 v1 升至 v2：事务内增加归档表并迁移连接 ID，保留旧记录中仍存在的原生会话引用；缺失的历史原生引用不能凭空恢复。迁移失败回滚全部改动、关闭数据库并释放进程锁。旧版程序会拒绝打开 v2 数据库，避免它忽略归档内容继续写入。部署前可先用已有 storage.backup 保存 v1 快照；备份恢复命令仍只写入不存在的新路径。

## 验证

新增 health-archive.test.ts 六项测试，覆盖自动空闲掉线、通信流断开但进程仍存活、重连、未支持探测不误报、连接/会话分离、归档备份与重启、完整历史恢复、幂等、迟到事件、未结束任务拦截、归档/恢复故障回滚、v1 迁移及迁移失败回滚。

完整自动化测试 53 项通过；格式检查通过。另运行 [60 秒 Core 负载](verification/health-archive-core-soak-2026-11-13.json)：120 个任务、102 待验收、18 计划取消，任务 p95 319 ms，中途重启一次；[100 次 MCP 生命周期](verification/health-archive-mcp-soak-2026-11-13.json) 全部成功，遗留监听句柄为 0。本轮没有重新运行一小时或真实模型压力测试。
