# Roundloom

以项目群聊为入口的多 Agent 协作桌面应用。用户可以分配任务、让 Agent 相互求助，并检查与代码版本关联的产物和真实测试证据。

当前处于后端开发阶段；Electron 桌面架构已确定，界面和安装包尚未交付。

## 已实现

- 消息、成员、任务、持久化调度、取消与崩溃恢复。
- SQLite 数据存储、事件订阅、幂等请求及版本化验收。
- 工作区与 Git worktree、真实命令执行、测试证据和文件产物核验。
- 权限交互、备份恢复、事件保留和数据库单实例保护。
- Mock、JSONL CLI 桥接、ACP v1 及 Claude/Codex 原生 SDK 适配器。

OpenCode 1.18.14 已验证 ACP 握手和一次真实问答；Claude Code 已验证真实两轮问答和后端重启续接。Codex 适配器通过协议测试，真实调用仍超时待排查；不宣称全部 Agent 兼容。真实模型调用不属于默认 CI。

## 快速开始

开发基线：Windows x64、Node.js 24、npm、Git。其他平台尚未完成验收。

```sh
npm ci
npm test
npm run demo
npm run build
npm start
```

`demo` 使用模拟成员，不调用付费模型。`start` 启动独立 Core，使用 JSONL 标准输入/输出；也支持可信父进程 IPC。默认数据保存到 `.roundloom`，可通过 `ROUNDLOOM_DATA_DIR` 修改。

## 架构

```text
React 界面 → 受限 IPC → Electron Main → 独立 Core → Agent 适配器
                                       ├─ SQLite
                                       └─ 工作区与执行证据
```

核心代码位于 `packages/`，集成测试位于 `tests/`，演示与恢复脚本位于 `scripts/`。

## 文档

- [产品需求](docs/01-product-requirements.md)
- [架构决策](docs/00-decisions.md)
- [桌面架构](docs/09-desktop-architecture.md)
- [适配器契约](docs/11-adapter-contract.md)
- [后端调用说明](docs/13-backend-implementation.md)
- [当前交付与验证边界](docs/14-backend-delivery.md)
- [原生 Agent 接入与实测](docs/15-native-agent-integration.md)
- [里程碑与验收](docs/04-milestones-and-acceptance.md)
- [贡献与分支约定](CONTRIBUTING.md)

历史设计文档保留其阶段背景；实际实现范围以交付记录和测试为准。

## 开发检查

```sh
npm run format:check
npm test
```

所有功能通过短期分支与 PR 合入 `main`。后端预览版本不会被描述为完整桌面产品。

## License

[MIT](LICENSE)
