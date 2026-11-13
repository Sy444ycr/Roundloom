# 桌面进程、目录与生命周期设计

日期：2026-11-13｜状态：进程、模块与生命周期架构已确认（C-11）；具体工具和阈值待细化，尚无应用实现

## 1. 模块边界

| 运行位置 | 负责 | 不负责 |
| --- | --- | --- |
| Renderer | React 页面、草稿、视图筛选、服务端状态投影 | 数据库、凭据、Agent 启动、任务终态裁定 |
| Preload | 按操作暴露 API、包装订阅和注销 | 任意频道转发、通用 shell、业务规则 |
| Main | 单实例入口、窗口与托盘、路径选择、Core 生命周期、校验 IPC 来源 | 调度循环、协议解析、数据库写入 |
| Core utility process | 业务服务、状态机、调度、持久化、适配器、工具请求授权 | 窗口和 UI 状态 |
| Agent 子进程或远程端 | 模型推理、工具执行、原生上下文 | 直接修改 Roundloom 数据库或冒用群身份 |

Core 是唯一数据库所有者。Renderer 重建不改变任务生命周期。Main 不持有一套可独立写入的任务状态，Core 不可用时明确返回 CORE_UNAVAILABLE。

Electron utilityProcess 提供 Node.js 与消息端口；Main—Core 使用消息端口通信，不将其 stdin 当作协议通道。普通 Agent 子进程仍可使用其支持的 stdio 协议。参见 [utilityProcess 官方文档](https://www.electronjs.org/docs/latest/api/utility-process)。

## 2. 建议目录

以下仅为规划，不创建对应源码目录。建议采用一个仓库，通过工作区包表达依赖边界；包管理器和构建工具在初始化前锁定版本。

```text
apps/
  desktop/
    src/main/             窗口、托盘、Core supervisor、IPC 路由
    src/preload/          最小桌面桥接 API
    src/renderer/         React 页面与组件
packages/
  contracts/              命令、事件、DTO、运行时校验 schema
  domain/                 状态转换、权限和任务规则，不依赖 Electron
  core/                   用例服务、调度器、事务与恢复编排、启动入口
  storage/                SQLite 仓储、迁移、事件与派发记录
  adapter-sdk/            适配器接口、能力定义、契约测试规范
  adapters/
    mock/                 明确标记模拟结果的测试适配器
    acp/                  ACP 协议转换
    native-*/             按真实接入需求新增的 SDK/CLI 实现
  tool-gateway/           Agent 群聊工具、身份绑定及请求关联
  workspace/              worktree、版本快照、产物获取与验证
tests/
  integration/            持久化、调度、故障注入
  desktop/                打包应用及窗口生命周期验证
  fixtures/               独立样例仓库与协议事件样本
docs/
```

依赖方向：desktop → contracts；Main 的启动入口加载 core；core → domain、contracts、adapter-sdk，并在组合入口注入 storage、workspace、adapters。domain 不导入数据库、Electron 或厂商 SDK；adapter-sdk 不导入 core；适配器不直接调用任务仓储。通过依赖规则检查阻止循环引用。

## 3. 桌面 API 与 IPC

Preload 建议暴露 rooms、members、messages、tasks、runs、artifacts、events、desktop 命名空间中的明确操作。例如 messages.send、tasks.assign、tasks.cancel、tasks.accept、events.subscribe 和 desktop.chooseWorkspace。不得暴露任意 channel、任意 SQL 或任意命令执行函数。

命令信封：protocolVersion、requestId、operation、payload；可变对象操作另含 expectedVersion。Main 绑定窗口身份，Core 绑定用户权限；actor 不接受 Renderer 随意指定。跨进程只传可序列化 DTO，不传数据库对象或带权限的原生句柄。

应答信封：requestId、ok、data 或结构化 error。新增错误包括 CORE_UNAVAILABLE、CONTRACT_MISMATCH、CURSOR_EXPIRED；业务错误沿用数据与接口规范。超时只说明结果尚未取得：先用原 requestId 查询或重试，不换 ID 重复派单。

订阅包含 roomId、afterSequence，返回 subscriptionId；窗口销毁时 Main 注销全部对应订阅。服务先建立受控缓冲，再读取持久化水位 H，补齐游标到 H 的事件，最后排空 H 之后的缓冲；或使用等价的持久化尾读机制，避免历史与实时切换漏事件。按 eventId 去重，顺序缺口触发补齐。

输出可合批推送；终态和交互请求不可丢弃。订阅积压超限时返回 RESYNC_REQUIRED，客户端重新读取快照与游标，不能无限占用 Main 内存。缓冲大小和批次阈值由 M1 测量确定。

Main 校验发送窗口及 frame 来源，Core 再校验业务作用域；文件选择返回受登记的 workspaceId，不能使任意路径自动获得访问权。界面加载受控本地资源，设置 CSP、限制导航及新窗口，外链按允许协议交给系统。参见 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

## 4. 启动与恢复

1. Main 获取单实例锁；重复启动只聚焦窗口，不启动第二个 Core。
2. 创建应用数据目录，启动 Core，传递协议版本及非秘密配置。
3. Core 打开存储、检查 schema 版本；必要迁移先备份，失败停止派发并展示诊断，不删除数据重建。
4. Core 与 Main 完成版本握手，加载当前状态，扫描遗留活跃 Run。
5. 对遗留执行查询原生状态或尝试受支持的恢复；无法核对则标 unknown，阻止同一原生会话再提交写操作。
6. 全局存储就绪后提供界面；单个连接恢复失败只阻塞相关成员。经核对可安全继续的派发才进入调度。

Core 每次启动生成 coreEpoch。Main 丢弃旧 epoch 的瞬时应答和端口消息；持久化 eventId 与 requestId 仍可跨 epoch 恢复。握手版本不兼容时拒绝业务请求，避免部分运行。

## 5. 关闭、退出与故障

| 场景 | 建议行为 |
| --- | --- |
| 关闭窗口 | 托盘可用时隐藏窗口并继续运行，首次说明；托盘不可用则保留窗口并提供退出入口 |
| 用户显式退出 | 冻结新派发，显示活跃任务；可选择等待、请求取消后退出或返回应用 |
| 取消失败或超时 | 展示仍在运行或未知的成员；只有用户明确选择仍然退出时才继续退出并保存恢复引用 |
| Renderer 崩溃 | 重建窗口并按游标恢复，不重启任务 |
| Core 崩溃 | Main 标记不可用并有限重启；再次握手与核对，不自动重放未知提交 |
| Main/系统异常退出 | 不保证 Agent 随之结束；下次启动核对原生引用，无法核对保持 unknown |

退出成功前落盘事件、派发状态与恢复引用，停止工具入口并关闭存储。Core 连续启动失败应停止重启并提供诊断；重试阈值待实现阶段确定。不得仅根据 PID 杀死旧进程，PID 可能已复用；进程树停止与身份核验需按操作系统验证。

## 6. 实施任务顺序

| 顺序 | 可交付设计对应的实现任务 | 出口证据 |
| --- | --- | --- |
| M1-A | 桌面壳、进程握手、受限 IPC | 打包版启动、关闭/恢复窗口、Core 失联可见 |
| M1-B | 持久化、命令幂等、事件订阅 | 重复提交、事务故障、订阅切换无丢失 |
| M1-C | mock 适配器、任务与调度状态机 | TC-02 至 TC-11 中适用模拟场景 |
| M1-D | 群聊与任务视图、产物和人工验收 | 明确模拟标识；桌面完整流程可演示 |
| M2-A | 首个真实适配器及打包验证 | 真实会话、取消/恢复能力记录、版本化产物 |
| M3-A | 第二条接入路径与群聊工具 | 异构成员求助、回复、续接、预算和停止证据 |

这只是对原里程碑的任务拆分，不改变 M4 开放接入验证，也不意味着获得开发授权。UI 库、SQLite 驱动、安装器和签名方案尚未固定；选择时应以目标系统和打包实测为依据。

