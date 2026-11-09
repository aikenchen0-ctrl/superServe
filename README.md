# superServe

## 服务端进度

已确认基座为 DSH + DeepSeek SuperAgent。当前先贯通工单内的最小后端骨架：

```text
已授权工单 + 目标 -> 分析 -> 执行 -> 评价 -> 总管验收 / 暂停 / 重核
                       各阶段复用 DSH 独立会话、知识接口和 SQLite 状态
```

仓库模式总管调用 `hmm_plan_create`，传入 `ticket_id` 和 `goal` 即可启动，不必手写节点。
本地管理入口为 `POST /orchestrator/api/tickets/:id/hmm/run`，正文为 `{"goal":"任务目标","mode":"single"}`；省略 `mode` 时使用 `multi`。
本机面板也可用 `POST /orchestrator/api/tasks` 直接提交 `{requestId, goal, title?, mode?}`，创建无需 GitHub/飞书触发的 HMM 工单；请求编号用于防止重复创建。
需要预先配置知识授权时，创建请求可加 `dispatch: false`：先保存计划，再授予节点权限，最后用现有 `dispatch` 命令启动；默认仍立即派发。
示例见 [待派发取证任务](examples/hmm-prepared-task.json)。这不是新的审批权限锁，也不允许在创建请求中夹带设备授权。
`mode` 可选 `single` 或 `multi`，默认 `multi`。`single` 只启动一个直接处理节点，适合目标明确且不需要拆分的任务；两者使用同一验收与权限边界。
在 DSH 的 `dsh-superagent` 插件配置中显式设置 `mode: hmm`，并使用独立 `stateDir`，即可省去 GitHub/飞书账号和仓库初始化。
该模式运行受限总管与 HMM 节点，仍需要可用的 DSH 模型配置；本地任务 API 仅对 loopback 同源管理端开放。
默认 `mode: repository` 保留上游仓库流程，部署检查失败不会自动切换模式。两种模式不共用状态目录。
多个就绪 HMM 工单轮转获得节点执行槽，有余量时继续分配；仍受原有全局和计划并发上限限制。
已有计划不会被覆盖；自定义结构仍可传 `plan` 创建，再用 `dispatch` 启动。`hold` 停止自动执行。
当前节点仅做推理和授权资料读取，没有手机操作或 Shell 工具；不是手机客户端公网接入服务。
运行 `pnpm test:backend` 验证后端状态及 DSH 集成。
部署后还需核对 `GET /orchestrator/api/state` 的 `build.sourceHash` 与构建产物
`dsh-superagent/build-info` 的值；构建通过不等于服务已加载新代码，源码模式该值为 `null`。
详见 [HMM 服务端说明](docs/hmm-backend.md)，自定义计划见 [示例](examples/hmm-plan.json)。
现已支持操作者显式导入有界证据片段、节点按版本读取、引用校验及资料变更后的 `recheck`。
程序区分任务输入、读取回执与上游结果；引用有效不等于结论真实，也不代表已接通手机知识库。
现已接入可信宿主设备端口、节点级数据域授权和按需读取回执，支持超时、撤权及迟到响应隔离。
真实手机认证、Android 桥接服务及指定香港通道仍需接入；回环 HTTP 集成测试不代表已连接手机或验证了公网 HTTPS。
已提供可替换的 `HttpDevicePort` HTTPS 出站适配器，负责固定路径、Bearer 凭据、有界流式响应和协议校验；
它不负责设备认证、发现、重连或公网监听，需由可信设备桥接器配合 `attachKnowledgeDevice` 注册。
也可显式加载可选插件 `dsh-superagent/device-http`：以固定桥接地址和凭据环境变量名配置一个设备，
宿主启动注册、卸载断开并取消在途请求；默认不启用，不新增节点读取权。配置示例见服务端说明。
总管和仓库执行器的 `knowledge_query` 现复用同一设备授权入口：指定 `node_id`、`grantId`，总管还需 `ticket_id`。
查询只返回有界来源元数据和短期句柄；同一调用者通过 `hmm_evidence` 的 `device_read` 按需取原文。
旧的全设备查询参数不再接受；设备注册不授予查询权，知识图谱仍使用工单内断言而非全局个人图谱。
现已支持工单内有界断言图：区分原文提取与推断，记录支持和反证引用，并由总管逐条复核后验收。
事实核验计划见 [断言示例](examples/hmm-claims-plan.json)；这不是跨工单个人知识图谱，复核也不证明客观真值。
本地管理 API 已支持计划修订预览与原子应用：增删、改写和重组步骤，撤销受影响结果、执行凭据与取证授权。
独立 HMM 总管可用 `hmm_read(view=plan)` 读取定义，再用 `hmm_plan_revise` 预览和调整步骤、依赖及嵌套分组。
该模型入口保持原目标与并发，不降低既有核验标记；受影响成果和知识授权失效，需重新派发和验收。尚未提供计划编辑界面。
本地任务可通过 `POST /orchestrator/api/tasks/:id/inputs` 补充上下文，正文为 `{"requestId":"稳定编号","text":"补充条件"}`。
请求按任务去重且有存储上限；总管按需读取后决定修订，补充信息不自动改变目标、节点输入或权限。
存在补充信息时，验收须携带 HMM 概览中的 `inputVersion`；新信息到达后旧版本不能验收，已有成果不因此自动作废。
`GET /orchestrator/api/tasks` 可分页找回本地任务，默认未结束、每页 20 条，最多 50 条；后续页使用返回的 `nextBefore` 作为 `before`。
可选 `state=open|ended|all`；按创建顺序排列，仅返回摘要。停止继续使用 `POST /orchestrator/api/tickets/:id/stop`。
`GET /orchestrator/api/tasks/:id` 返回紧凑进度、最多 4 条挂起原因摘要、暂停及待验收状态，并在验收交付后提供当前有效的最终摘要。
查询不返回历史正文、节点指令或会话；已交付结果的来源被撤回时返回失效代码，避免继续作为有效结果提供。
宿主检测到模型故障时，挂起摘要附带 `modelFailureCode` 和固定中文说明；未知故障不解析文案猜测，不外传提供方正文。
诊断跨重启保留，修复运行条件后沿用 `resume` 恢复；不自动重试、切换提供方或重置次数。
总管回合故障另见 `GET /orchestrator/api/state` 的 `controllerFailure`，并反映在 `health.models`；
该信息由原生会话日志重建，不写入各节点状态，空闲或取消不被视为恢复。
运行 `pnpm eval:hmm` 可重复执行四类固定设备场景，生成 `.artifacts/hmm-baseline.json`。
它记录节点会话、设备端口载荷、上下文和状态快照预算；使用模拟模型和设备，不代表真实模型质量或手机性能。
历史比较命令为 `pnpm eval:hmm --compare .artifacts/hmm-baseline.json`，会先读取旧报告再生成本轮报告。

superServe is a research baseline for a personal multi-device agent system. It
starts from the MIT-licensed DeepSeek Assistant
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
and keeps its orchestration contracts while replacing the code-hosting-specific
runtime around them.

The imported prototype is research code, not an official DeepSeek product and
not production-ready software. Its original design and documentation are
retained under `docs/`, `prompts/`, and `src/`.

## Intended changes

- Add personal knowledge and graph services as first-class capabilities.
- Add authenticated clients for Android, iOS, and root Android knowledge agents.
- Replace repository-only execution with constrained typed tools and execution
  backends.
- Keep tenant state recoverable while allowing device-local source data.
- Add record retention, compaction, and deletion policies.
- Keep the upstream orchestration lifecycle:
  `Source -> Trigger -> Eval -> Mandate -> Ticket -> Assignment -> Report`.

Run `pnpm check` for the upstream typecheck, tests, and build. Architecture gaps
and the staged migration are documented in
[`docs/009-superServe-architecture.md`](docs/009-superServe-architecture.md).

工作树协作、自动集成、持续优化及 DSH 升级见
[多 Agent 开发平台总体设计](docs/agent-development-platform-design.md)。
执行拆解、当前进度和验收边界见 [问题空间](docs/问题空间.md)。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Upstream baseline

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

`src/hmm/handoff.ts`、`src/hmm/context-checkpoint.ts` 和 `src/executor/controller-context.ts` 中改编自 DS-Bot 的代码适用 Apache-2.0；来源和修改声明见 [NOTICE](NOTICE)，许可全文见 [Apache-2.0](LICENSES/Apache-2.0.txt)。
