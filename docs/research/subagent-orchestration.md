# Subagent 编排：分配、调度、通信与控制（对比调研）

> 调研日期：2026-10-29。目标：参照 Claude Code / Claude Agent SDK、OpenAI Codex CLI、OpenCode、Pi 的 subagent 示例，为 orqestra 的 Subagent 规划更高效的分配与调度、稳定的通信机制和更细的控制。
>
> 只采用一手来源（官方文档、源码）。源码链接固定到调研时的 commit：
> - Codex：`openai/codex@3535c22b`
> - OpenCode：`anomalyco/opencode@13413879`（`sst/opencode` 已迁到这个组织；主干已重构到 `packages/core`）
> - Pi：`earendil-works/pi@babe30a7`（`badlogic/pi-mono` 的现址；内容与我们安装的 `@earendil-works/pi-coding-agent@1.4.0` 中的示例一致，已逐行 diff 过）
>
> 文中标「推断」的内容没有直接出处，是我根据代码得出的结论。

---

## 1. orqestra 现状

### 1.1 Subagent 怎么产生

- 每个 Run 由 BullMQ worker 从 `AGENT_RUNS_QUEUE` 取出，执行 `runTurn` → `reply`（`apps/worker/src/run.ts:60-164`，`packages/db/src/index.ts:11`）。
- `reply` 给父 Agent 装上 Search/Scrape 和**一个** `subagentTool(...)`（`run.ts:97-111`）。`subagentTool` 每个 Run 只构造一次，所以 `limiter(MAX_SUBAGENTS)` 是**每个 Run 一份**（`tools.ts:153`）。
- 分配方式：父 LLM 调用 `subagent` 工具，参数是 `tasks: [{ brief, template? }]`，`1..MAX_SUBAGENT_TASKS(8)` 个（`tools.ts:217-229`）。`template` 取自任意 Agent Definition（`config.agents`），工具描述里列出所有模板的 id/name/description（`tools.ts:154-156, 216`）。不传 template 时使用内置的 `GENERAL_WORKER` 提示词（`tools.ts:101-102`）。
- 每个子任务都是**同进程**内新建的一个 `pi-agent-core` `Agent`：上下文为空，只有 brief 这一条 user 消息（`tools.ts:167-184`）。
  - Model：模板自己声明了 Models（`!allModels`）就用模板的默认值，否则继承父 Agent 的 model 和 thinking（`tools.ts:163-171`）。
  - Tools：父 Agent 的 Tools 与模板 `tools` 的交集。子 Agent **拿不到 `subagent` 工具**，所以不能嵌套（`tools.ts:146, 172-178`；GLOSSARY「Subagent … cannot start Subagents of its own」）。
- 校验：未知的 template id，或者模板没有可用 Model，会直接 `throw`，**整次调用的所有任务都失败**（`tools.ts:231-238`）。

### 1.2 限制与调度

| 限制 | 值 | 位置 | 作用范围 |
|---|---|---|---|
| `MAX_SUBAGENTS` | 4 | `tools.ts:20` | 每个 Run 同时运行的 Subagent 数，多出的按 FIFO 排队（`limiter`，`tools.ts:113-142`，测试见 `tools.test.ts`） |
| `MAX_SUBAGENT_TASKS` | 8 | `tools.ts:22` | **单次**工具调用的任务数（schema 上的 `maxItems`） |
| `MAX_SUBAGENT_STEPS` | 20 | `tools.ts:24` | 每个 Subagent 最多发 20 次 Model 请求，用 `finishTurn` 直接 `end`（`tools.ts:182-183`） |
| `WORKER_CONCURRENCY` | 默认 8 | `run.ts:339`，`index.ts:14-25` | 一个 worker 进程同时处理的 Run 数 |
| `PROVIDER_CONCURRENCY` | 默认 8 | `run.ts:312-329` | 每个 Provider 同时进行的 Model 请求数，按 worker 进程统计，**父 Agent 和 Subagent 共用**（Subagent 的 `streamFn` 就是包装过的 `config.streamSimple`） |

调度要点：
- `pi-agent-core` 的 `toolExecution` 默认是 `"parallel"`（[pi `packages/agent/src/types.ts:315-317`](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/agent/src/types.ts#L315-L317)）。父 Agent 在一条回复里发出多个 `subagent` 调用时，这些调用会并行执行，但共用同一个每 Run 的 limiter。
- **总量没有上限**：每次调用最多 8 个任务，但父 Agent 可以在多轮里反复调用，所以一个 Run 能产生的 Subagent 总数只受父 Agent 自身的步数限制。父 Agent 当前**没有** `finishTurn`（`run.ts:99-116`）。
- 真正起全局节流作用的是 `providerLimiter`：一个 worker 最多 8 个 Run × 4 个 Subagent = 32 个 Agent 争抢每个 Provider 的 8 个请求槽位。

### 1.3 结果与进度怎么回传

- **结果**：所有任务 `Promise.all` 完成后，一次性返回 `<result task="i">…</result>` 拼成的文本（`tools.ts:239-251`）。取的是「最后一条非空 assistant 文本」（`tools.ts:197-205`）。失败或撞到步数上限时，在文本**末尾追加**一句英文提示（`tools.ts:206-209`）。
- **完整过程**：`details.subagents: SubagentTranscript[]`（`tools.ts:105-111`）随 toolResult 消息一起写进 `message` 表（`run.ts:132-145`）。前端 `ToolCallView`/`SubagentView` 从 `details` 渲染（`apps/web/src/routes/_app/c.$conversationId.tsx:198-226, 249`）。
- **流式进度：没有**。worker 只把父 Agent 的 `text_delta`/`thinking_delta` 通过 `pg_notify(conversationChannel)` 推出去（`run.ts:117-129`；事件类型见 `packages/db/src/index.ts:23-26`，只有 `start | delta | saved`）。Subagent 的 Agent 没有 `subscribe`，执行期间 UI 只显示一个转圈，直到整批任务结束。
- **运行中发消息：没有**。父子之间唯一的通道就是 brief 进、最终文本出。

### 1.4 取消、超时、错误

- 停止：web 端 `NOTIFY conversation_stop` → worker 把对应 Run 的 `AbortController` abort 掉（`run.ts:350-353`）→ 父 `agent.abort()`（`run.ts:149`）→ 工具的 `signal` → 每个 Subagent `agent.abort()`（`tools.ts:185-191`）。排队中的任务从 limiter 中移除并 reject（`tools.ts:117-132`）。
- **超时：没有**。只有步数上限，单个 Subagent 不受墙钟时间约束。进程关闭时会有 10 秒的硬退出（`apps/worker/src/index.ts:27-36`）。
- **问题（推断，依据代码）**：
  1. 用的是 `Promise.all`，只要一个任务 reject（例如停止时排队任务被 reject，或 `run()` 内部抛错），整个工具调用就会抛错，**已完成的 Subagent 的 transcript 和结果全部丢失**，不会进入 `details`。
  2. 撞到步数上限时，最后一条 assistant 消息可能只有 tool call 没有文本，`result` 就退回到更早的一段文本，甚至是空串。
  3. 父 Agent 只能从文本末尾的英文句子判断状态，没有结构化的状态字段。
  4. 没有 usage/cost 统计，因此也做不了预算控制。

---

## 2. 各系统的做法

### 2.1 Claude Code / Claude Agent SDK

**分配**
- 由主 Agent 调用 `Agent` 工具（v2.1.63 以前叫 `Task`，旧名仍可作为别名）决定是否委派、委派给谁，依据是各 subagent 的 `description`。参数中只有 prompt 字符串会传给子 Agent。[sub-agents](https://code.claude.com/docs/en/sub-agents)；[agent-sdk/subagents「What subagents inherit」](https://code.claude.com/docs/en/agent-sdk/subagents#what-subagents-inherit)
- 定义方式：`.claude/agents/*.md` 的 frontmatter，或 SDK 的 `agents` 选项。字段包括 `description`、`prompt`、`tools`（白名单）、`disallowedTools`（黑名单，先于 `tools` 应用）、`model`（可设为 `inherit`）、`maxTurns`、`permissionMode`、`background`、`isolation: worktree`、`skills`、`mcpServers`、`effort` 等。[sub-agents#frontmatter-reference](https://code.claude.com/docs/en/sub-agents#frontmatter-reference)；[agent-sdk/subagents#agentdefinition-configuration](https://code.claude.com/docs/en/agent-sdk/subagents#agentdefinition-configuration)
- 不指定 `subagent_type` 时使用内置的 `general-purpose`。[agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents#programmatic-definition-recommended)
- 可以限制「能派哪些 subagent」：`tools: Agent(worker, researcher)`，或在权限里写 `deny Agent(Explore)`。[sub-agents#restrict-which-subagents-can-be-spawned](https://code.claude.com/docs/en/sub-agents#restrict-which-subagents-can-be-spawned)

**调度**
- 前台模式阻塞主对话；后台模式并发运行，结果「在之后的一轮里以完成通知的形式」送达。SDK 中 Agent 工具结果会带 `status: "async_launched"` 或 `"completed"`。[sub-agents#run-subagents-in-foreground-or-background](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)；[agent-sdk/subagents#choose-whether-claude-waits-for-subagents](https://code.claude.com/docs/en/agent-sdk/subagents#choose-whether-claude-waits-for-subagents)
- 并发上限默认 20（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）。达到上限时**直接拒绝**，返回 `Concurrent subagent limit reached` 并告诉 Claude 不要重试，**不排队**。会话内的 subagent 总数不设上限。[sub-agents#concurrent-subagent-limit](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit)
- 嵌套默认 3 层（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`，设为 1 即禁止嵌套）。到达最深一层时直接收回 `Agent` 工具。[sub-agents#let-subagents-spawn-their-own-subagents](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)
- 花费上限：`maxBudgetUsd` 把 subagent 的请求也计入，到达上限后拒绝再派、停掉后台 subagent，并以 `error_max_budget_usd` 结束。[agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend](https://code.claude.com/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend)

**通信**
- 只有最终报告会回到父 Agent。父 Agent 读取前，系统会扫描报告中的「指令形」模式：中和伪造的控制标签和 `Human:`/`Assistant:` 回合标记，并在报告前加一行 `[harness: ...]` 标记。[agent-sdk/subagents#what-subagents-inherit](https://code.claude.com/docs/en/agent-sdk/subagents#what-subagents-inherit)；[sub-agents#subagent-output-scanning](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)
- SDK 流里，子 Agent 产生的消息带 `parent_tool_use_id`（TS 版还带 `agent_id`），调用方可以据此实时展示子过程。[agent-sdk/subagents#detect-subagent-invocation](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)
- 续跑：结果里带 `agentId`，用 `SendMessage(to=id 或 name)` 唤醒的子 Agent 保留完整历史，在后台继续运行。子 Agent 之间也可以互发消息，名字被新 Agent 占用时系统会拒绝投递。transcript 单独存成 `subagents/agent-{id}.jsonl`。[sub-agents#resume-subagents](https://code.claude.com/docs/en/sub-agents#resume-subagents)

**控制**
- `maxTurns` 到达后返回的输出会被**标记为 partial**，之后可以续跑。[agent-sdk/subagents#agentdefinition-configuration](https://code.claude.com/docs/en/agent-sdk/subagents#agentdefinition-configuration)
- API 错误：输出被截断但已有文本时，先提示子 Agent 继续；前台模式返回部分输出并注明「被截断」，什么都没产出时报 `Agent terminated early due to an API error`；后台模式标记为 failed，同时附上最后的输出，「partial work isn't lost」。[sub-agents#api-errors-in-subagents](https://code.claude.com/docs/en/sub-agents#api-errors-in-subagents)
- Hooks：`SubagentStart` 不能阻止创建，但可以向子 Agent 注入上下文。`SubagentStop` 能拿到 `agent_id`、`agent_type`、`agent_transcript_path`、`last_assistant_message`；返回 `decision: "block"` 可以让子 Agent 继续工作，`reason` 会作为它的下一条指令。[hooks#subagentstart](https://code.claude.com/docs/en/hooks#subagentstart)；[hooks#subagentstop](https://code.claude.com/docs/en/hooks#subagentstop)
- 后台 subagent 只保留一组较小的内置工具集。[sub-agents#available-tools](https://code.claude.com/docs/en/sub-agents#available-tools)

### 2.2 OpenAI Codex CLI（Rust，`codex-rs`）

**分配**
- 多 Agent 功能由 feature flag 控制：`multi_agent`（Stable，默认开）和 `multi_agent_v2`（Stable，默认关）。[features/src/lib.rs:1574-1585](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/features/src/lib.rs#L1574-L1585)
- 模型通过 `spawn_agent` 派生子 Agent，参数有 `message`/`items`、`agent_type`（角色）、`fork_context`（为 true 时复制当前线程的全部历史）、`model`、`reasoning_effort`（不填则继承父 Agent）。[multi_agents_spec.rs:610-647](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L610-L647)
- 角色在 `config.toml` 的 `[agents]` 下声明：`description`、`config_file`（一层角色专属的配置，可以改 model、指令等）、`nickname_candidates`。[config_toml.rs:800-813](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/config/src/config_toml.rs#L800-L813)

**调度**
- 每个子 Agent 是一个完整的 Codex 线程（thread）。`agent_max_threads` 默认 6；v2 中改为 `max_concurrent_threads_per_session`，默认 4，减 1 后作为上限。超过上限时报 `AgentLimitReached`，**直接拒绝**。[config/mod.rs:260-270](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/config/mod.rs#L260-L270)，[mod.rs:1716-1730](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/config/mod.rs#L1716-L1730)，[agent/registry.rs:97-106](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/agent/registry.rs#L97-L106)
- 嵌套深度 `agent_max_depth` 默认 **1**。超过时返回 `"Agent depth limit reached. Solve the task yourself."`。[config/mod.rs:270](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/config/mod.rs#L270)，[multi_agents/spawn.rs:74-78](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L74-L78)
- `close_agent` 会关闭目标 Agent 及其所有子孙。已完成但没关闭的 Agent **仍然占用并发名额**。[multi_agents_spec.rs:344-347](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L344-L347)

**通信**
- 是一组显式的「邮箱式」工具：`send_input`（`interrupt=true` 时立即打断当前任务，否则排队）、`wait_agent`（带超时，默认 30s，最短 10s，最长 1h，超时返回空状态）、`resume_agent`、`close_agent`。v2 增加了 `send_message`（不触发新回合）、`followup_task`、`list_agents`、`interrupt_agent`。[multi_agents_spec.rs:175-380](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L175-L380)，[config/mod.rs:262-264](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/config/mod.rs#L262-L264)
- 子线程结束时，completion watcher 把完成消息投递给父线程（只在 `SubAgentSource::ThreadSpawn` 下启用）。[agent/control.rs:440-560](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/agent/control.rs#L440-L560)
- 底层协议是 SQ/EQ：客户端提交 `Submission { id, op }`，Agent 推送 `Event { id, msg }`，其中 `id` 关联到对应的 submission。多 Agent 有专门的事件：`CollabAgentSpawnBegin/End`、`CollabAgentInteractionBegin/End`、`CollabWaitingBegin/End`。[core/src/session/submission.rs:9-22](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/session/submission.rs#L9-L22)，[protocol/src/protocol.rs:1497-1520](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/protocol/src/protocol.rs#L1497-L1520)，[protocol.rs:1721-1731](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/protocol/src/protocol.rs#L1721-L1731)

**控制**
- 中断：`Op::Interrupt` 中止当前任务，服务端回送 `TurnAborted`。[protocol.rs:695-698](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/protocol/src/protocol.rs#L695-L698)
- 审批与沙箱：应用角色配置之后，**再把父 Agent 运行时的 `approval_policy`、approvals reviewer、cwd 和 permission profile 覆盖回去**。也就是说，角色不能放宽父 Agent 的审批或沙箱。[agent/control/spawn.rs:332-365](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/agent/control/spawn.rs#L332-L365)
- `agent_interrupt_message_enabled`：子 Agent 被打断时，是否写一条模型可见的消息。[config/mod.rs:983-984](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/core/src/config/mod.rs#L983-L984)

### 2.3 OpenCode

**分配**
- Agent 有 `mode: primary | subagent | all` 三种，默认 `all`。`hidden: true` 的 Agent 不出现在 `@` 补全里，只能由其他 Agent 调用。[docs agents.mdx「Mode」「Hidden」](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/web/src/content/docs/agents.mdx#L573-L609)
- `subagent` 工具（文档中旧称 Task tool）的参数：`agent`、`description`（3-5 个词，展示给用户）、`prompt`、`model?`、`sessionID?`（续跑）、`background?`。[tool/plugin/subagent.ts:29-54](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L29-L54)
- 工具描述中只列出「当前 Agent 有权调用」的 subagent：`permission.task` 用 glob 匹配，`allow/ask/deny`，最后一条匹配规则生效，`deny` 的项直接从描述里删掉。[subagent.ts:290-311](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L290-L311)；[agents.mdx「Task permissions」](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/web/src/content/docs/agents.mdx#L614-L642)。执行时还会再做一次 `permission.assert`（[subagent.ts:144-157](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L144-L157)）。
- Model 优先级：调用时显式指定 > Agent 配置 > 父 session。[subagent.ts:190](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L190)

**调度**
- 每个 subagent 是一个**持久化的子 session**（`parentID` 指向父 session）。[subagent.ts:191-203](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L191-L203)
- 前台模式用 `jobs.block` 等待完成；后台模式立即返回，并在提示中写明「不要轮询、不要重复做它的工作」。前台运行中的任务也可以转为后台。[subagent.ts:17-27, 235-250](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L235-L250)
- 嵌套深度 `experimental.subagent_depth` 默认 **1**。[subagent.ts:121-140](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L121-L140)
- 在 `subagent.ts` 和 `job.ts` 中**没有找到**针对 subagent 的并发上限（按源码检索，结论可能不完整）。

**通信**
- 结果格式：`<subagent sessionID="…" state="completed">…</subagent>`，附带 `metadata.status`。[subagent.ts:262-271](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L262-L271)
- 后台完成后，用 `sessions.synthetic` 往父 session 插入一条带 `state="completed|error|cancelled"` 的合成消息。[session/subagent-completion.ts:23-45](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/session/subagent-completion.ts#L23-L45)
- 运行中发消息：带 `sessionID` 再次调用工具即可。子 session 空闲时会被唤醒，**运行中则 steer**（插入一条消息）。只能操作自己的子 session。[subagent.ts:159-186, 209-226](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L209-L226)
- 进度：`context.progress({ sessionID, status: "running" })`。UI 可以进入子 session 实时查看（`session_child_first` 快捷键）。[subagent.ts:207](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L207)；[agents.mdx「Usage」](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/web/src/content/docs/agents.mdx#L132-L151)
- 后台任务的完成通知有持久化标记（KV），用于重启后恢复。[job.ts:178-212](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/job.ts#L178-L212)

**控制**
- `steps` 上限：到达后**最后一步注入 `MAX_STEPS_PROMPT`，并设置 `toolChoice: "none"`**，强制模型只用文本作答，保证有总结可交。工具定义保留，以免破坏缓存前缀。[session/runner/llm.ts:249-268](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/session/runner/llm.ts#L249-L268)，[runner/max-steps.ts](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/session/runner/max-steps.ts)，[runner/step.ts:92-93](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/session/runner/step.ts#L92-L93)
- 取消：父工具被中断时，同时 `sessions.interrupt(child)` 和 `jobs.cancel(child)`。[subagent.ts:240-245](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L240-L245)
- 失败：返回 `ToolFailure`，其中带上 `sessionID`，模型可以接着续跑。[subagent.ts:251-257](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/tool/plugin/subagent.ts#L251-L257)

### 2.4 Pi 的 subagent 示例扩展

位置：[`packages/coding-agent/examples/extensions/subagent/`](https://github.com/earendil-works/pi/tree/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent)（`index.ts`、`agents.ts`、`agents/*.md`、`prompts/*.md`）。下文 `index.ts:N` 都指这个目录下的文件。

**分配**
- 三种模式：single `{agent, task}`、parallel `{tasks:[...]}`、chain `{chain:[...]}`。chain 中用 `{previous}` 占位符引用上一步的输出，第一步失败就停止。[index.ts:1-12](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L1-L12)，[index.ts:548-600](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L548-L600)
- Agent 定义是带 frontmatter 的 Markdown，字段有 `name`、`description`、`tools`、`model`。不写 `model` 就继承调度方的 model 和 thinking level。默认只加载用户级 agents，项目级 agents 需要显式开启并经过确认（安全考虑）。[README.md](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/README.md)

**调度**
- `MAX_PARALLEL_TASKS = 8`，`MAX_CONCURRENCY = 4`。用 `mapWithConcurrencyLimit` 做 worker 池（[index.ts:34-37](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L34-L37)，[index.ts:217-237](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L217-L237)）。**我们的 4/8 正是照搬这里的数值。**
- 进程隔离：每个任务 `spawn` 一个 `pi --mode json -p --no-session [--model] [--tools a,b] --append-system-prompt <tmpfile> "Task: …"`。[index.ts:298-345](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L298-L345)

**通信**
- 逐行解析子进程 stdout 上的 JSON 事件。每收到一个 `message_end` 或 `tool_result_end` 就累加 usage（turns/tokens/cost），然后通过工具的 `onUpdate` 推送一次部分结果，所以父 UI 能实时看到子 Agent 的工具调用。[index.ts:322-330](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L322-L330)，[index.ts:360-386](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L360-L386)
- parallel 模式下，每个任务各自回调 `onUpdate`，汇总成「2/3 done」。最终输出为 `Parallel: x/y succeeded` 加上每个任务的 `### [agent] completed|failed (reason)`，**每个任务最多 50KB**，完整内容保留在 details 里。[index.ts:643-682](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L643-L682)
- 运行中**不能**向子 Agent 发消息（`stdin` 是 `ignore`）。

**控制**
- 取消：abort 时先 `SIGTERM`，5 秒后补发 `SIGKILL`。[index.ts:408-417](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L408-L417)
- 失败判定：`exitCode !== 0`，或 `stopReason` 为 `error`/`aborted`。[index.ts:180-182](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/examples/extensions/subagent/index.ts#L180-L182)
- 没有步数、时间、预算限制，也没有显式的递归深度保护（在 `index.ts` 中检索 depth/env 均无结果）。子进程能否再派 subagent，取决于 `--tools` 白名单和子进程加载了哪些扩展（推断）。

### 2.5 我们已有但没用上的 pi-agent-core 能力

我们的运行时 `@earendil-works/pi-agent-core@1.4.0` 已经提供了：
- `AgentTool.execute(toolCallId, params, signal, onUpdate)`：第 4 个参数 `onUpdate` 用于推送部分结果，父 Agent 会相应发出 `tool_execution_update` 事件。[pi `packages/agent/src/types.ts:487`, `:530`](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/agent/src/types.ts#L480-L535)
- `Agent.steer(message)`：在当前 assistant 回合结束后插入一条消息。`Agent.followUp(message)`：在 Agent 本来要停下时追加一条消息。[pi `packages/agent/src/agent.ts:308`](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/agent/src/agent.ts#L300-L320)
- `finishTurn`：可以 `end` 或 `continue`（我们已经在用）。

---

## 3. 对比表

| 维度 | orqestra（现状） | Claude Code / SDK | Codex CLI | OpenCode | Pi 示例 |
|---|---|---|---|---|---|
| 谁决定分配 | 父 LLM，一次调用批量下发 brief | 父 LLM，依据 `description` | 父 LLM（`spawn_agent`） | 父 LLM，或用户 `@` 指定 | 父 LLM，或 prompt 模板 |
| 模板/角色 | 任意 Agent Definition | `.claude/agents` / `agents` | `[agents]` 角色加 config 层 | `mode: subagent` 的 agent | `agents/*.md` |
| 能派谁的限制 | 无（所有定义） | `Agent(x,y)`、deny 规则 | 无专门机制（未查到） | `permission.task` glob | 用户级/项目级范围 |
| 执行单元 | 同进程 `Agent` | 独立会话（transcript 文件） | 独立线程 | 持久子 session | 子进程 |
| 并行 | 每次调用的多个 task 并行 | 前台/后台 | 异步加 `wait_agent` | 前台/后台 | parallel/chain |
| 并发上限 | 每 Run 4，**排队** | 20，**拒绝** | 6（v2 为 3），**拒绝** | 未查到 | 4，排队 |
| 总量/预算 | 每次调用 8，**无总量上限** | `maxBudgetUsd` | 名额持续占用直到 close | — | 每次调用 8 |
| 嵌套 | 0（禁止） | 默认 3 | 默认 1 | 默认 1 | 无保护 |
| 步数上限 | 20，硬截断 | `maxTurns`，标记为 partial | — | `steps`，**最后一步强制纯文本** | 无 |
| 墙钟超时 | 无 | 未查到 | `wait_agent` 超时（等待本身） | 未查到 | 无 |
| 结果格式 | `<result task=i>` 加文本尾注 | 最终报告，经扫描后加 header | 完成通知或 `wait` 状态 | `<subagent sessionID state>` | `### [agent] status`，50KB 上限 |
| 流式进度 | **无** | `parent_tool_use_id` 消息流 | Collab* 事件 | 可进入子 session 查看 | `onUpdate` 实时推送 |
| 运行中发消息 | 无 | `SendMessage` | `send_input`(interrupt) / `send_message` | 带 `sessionID` 再调用（steer） | 无 |
| 续跑 | 不可 | 可（agentId） | `resume_agent` | 可（sessionID） | 不可 |
| 取消 | AbortSignal 级联 | Esc / `TaskStop` | `Op::Interrupt` / `interrupt_agent` | interrupt 加 job cancel | SIGTERM→SIGKILL |
| 部分失败 | **一个 reject 全部丢失** | 保留部分输出 | 按 Agent 分别报状态 | 按子任务分别报状态 | 按任务报 succeeded/failed |
| 权限继承 | 工具取交集 | 继承父权限，父模式优先 | 强制沿用父 approval/sandbox | 权限按 agent 分别配置 | `--tools` |

---

## 4. 对 orqestra 的建议（按改动从小到大排列）

原则：保持 GLOSSARY 里的定义不变（Subagent 属于某个 Run 的 Turn，不能被续跑，不能嵌套），先把**现有同步模型做稳**，再谈异步。

### P0：稳定性，各约十行改动

1. **部分失败不丢结果**（`tools.ts` `subagentTool.execute`，239-251）
   - `Promise.all` 改成 `Promise.allSettled`。被拒绝的任务（排队时被取消、`run()` 抛错）生成一条 `{ brief, template, messages: [], result: "[stopped]" | "[failed: …]" }` 记录，已完成的照常写进 `details`。
   - 参照：Pi 按任务报 succeeded/failed（`index.ts:664-672`），Claude Code「partial work isn't lost」。
   - 取舍：被停止的 Run 仍然会保存这条 toolResult，这正是我们想要的效果（`run.ts:130-145` 本来就保存 toolResult）。

2. **结构化状态，不再用文本尾注**（`tools.ts:201-209, 245-248`）
   - `SubagentTranscript` 增加 `status: "completed" | "partial" | "failed" | "stopped"`，输出改为 `<result task="1" status="partial">`。
   - 参照：OpenCode 的 `state=` 属性，Claude 的 partial 标记。
   - 前端 `SubagentView` 可以直接显示状态（`c.$conversationId.tsx:198-205` 的类型需同步增加该字段）。

3. **到步数上限时强制交出总结**（`tools.ts:182-183`）
   - 现在的做法是第 20 步直接 `end`，可能拿不到任何文本。改为照 OpenCode 的方式：到第 N 步时用 `agent.steer()` 插入一条「已达上限，立即用纯文本总结」的消息，再允许**一次**不带工具的请求。如果 pi 不支持按请求关掉工具，就在该步移除 `tools`；具体能否做到需先验证 pi `Agent` 是否允许运行中修改 `state.tools`。
   - 依据：[OpenCode llm.ts:249-268](https://github.com/anomalyco/opencode/blob/1341387981e7de693198080fbed24d6ec3e4343b/packages/core/src/session/runner/llm.ts#L249-L268)。
   - 取舍：多一次 Model 请求，但父 Agent 不会再拿到空结果。

4. **单个 Subagent 墙钟超时**（`tools.ts` `run()`）
   - 用 `AbortSignal.any([signal, AbortSignal.timeout(MAX_SUBAGENT_MS)])` 传给 `run`。超时后状态记为 `partial`/`stopped`，保留已有输出。使用 Node 内置 API，不需要新依赖。
   - 取舍：值定得太小会砍掉慢 Provider 上的正常任务。建议起步 5 分钟，放在常量里。

### P1：通信，即流式进度（最显著的体验提升）

5. **把 Subagent 进度实时推给 UI**
   - `tools.ts`：`execute` 使用第 4 个参数 `onUpdate`；每个 Subagent `agent.subscribe` 到 `message_end` 时，调用 `onUpdate({ content, details: { subagents: 当前快照 } })`。做法与 Pi 示例 `index.ts:322-330, 360-386` 完全相同，只是我们在同进程内，不需要解析 JSON 行。
   - `run.ts:117`：父 Agent 的 subscribe 增加 `tool_execution_update` 分支 → `notify(conversationId, { type: "tool", toolCallId, details })`。
   - `packages/db/src/index.ts:23-26`：`ConversationEvent` 增加一个变体。
   - web：`ToolCallView` 在 toolResult 还没到时，用最新的 update 渲染 `SubagentView`。
   - 取舍：`pg_notify` 的 payload 上限是 8000 字节（PostgreSQL 默认值；本文没有核对官方文档的具体出处，实现前需确认），**不能推完整 transcript**。只推每个子任务的 `{status, steps, 最后一个工具名/参数摘要}`，完整内容仍然等 toolResult 落库。需要节流（例如每个子任务每秒最多一次）。

6. **usage 统计**（`tools.ts` `run()`）
   - 累加每条 assistant 消息的 `usage`，写进 `SubagentTranscript.usage`（Pi 示例 `index.ts:365-374`）。这样 UI 可以显示 token/cost，也为第 8 条打基础。

### P2：控制，按需做

7. **每个 Run 的 Subagent 总量上限**（`subagentTool` 闭包里加一个计数器）
   - 例如 `MAX_SUBAGENTS_PER_RUN = 16`。超过时返回错误文本，让父 Agent「自己完成」，措辞参照 Codex 的 `"Solve the task yourself."`。这样补上「每次调用 8 个、但调用次数不限」的缺口。
   - 取舍：比按 token 预算简单，但粒度粗。

8. **按 token 预算控制**（依赖第 6 条）
   - 在 Run 级别累计 Subagent 的 usage，超过预算就拒绝再派、abort 正在运行的 Subagent，参照 Claude `maxBudgetUsd` 的三种动作。只在出现成本问题时再做。

9. **限制「能派谁」**（`AgentDefinition` 增加可选字段 `subagents?: string[]`，在 `subagentTool` 过滤 `templates`，即 `tools.ts:154-156, 232`）
   - 参照：OpenCode `permission.task`（deny 的项从描述中删除），Claude `Agent(worker, researcher)`。
   - 当前模板数量少，可以先不做。等 Agent Definition 多起来、工具描述变长时再加。

10. **把限额改为可配置**：`MAX_SUBAGENTS` 走环境变量，与 `WORKER_CONCURRENCY` 和 `PROVIDER_CONCURRENCY` 同一方式（`index.ts:14-25`），通过 `startAgentWorker` 的 options 传入。改动很小。

### 不建议照搬（至少现在不要）

- **后台/异步 Subagent 加 SendMessage/resume**（Claude、Codex v2、OpenCode）
  - 这需要把 Subagent 变成持久实体，提供邮箱，并且在 Run 结束之后还能把结果投递回去。这与我们「Run = 一个 BullMQ job，Subagent 属于该 Run 且不可续跑」的模型（GLOSSARY「Subagent」「Run」）冲突，而且 `maxStalledCount: 0` 的崩溃语义也要重新设计。
  - 如果将来确实需要，OpenCode 的方案最贴近我们的数据模型：子任务作为带 `parentID` 的子 Conversation，完成后往父 Conversation 插入一条合成消息。
- **嵌套 Subagent**：Codex 和 OpenCode 默认都只允许 1 层（即不嵌套）。我们目前只有 Search/Scrape，嵌套只会让成本成倍增长，收益很小。
- **进程隔离**（Pi spawn 子进程）：Pi 这样做是因为 coding agent 有 bash 和文件写入。我们的 Tools 是外部 HTTP 服务，同进程 + AbortSignal 已经足够，用子进程反而会失去 `providerLimiter` 的共享计数。
- **chain 模式 / `{previous}`**：父 LLM 可以分多轮自己串联，加这个模式会让工具 schema 更复杂。
- **fork_context**（Codex）、fork（Claude）：会复制父 Agent 的上下文，与我们「brief 必须自包含、保持上下文干净」的设计目标相反，token 成本也高。
- **到达并发上限时直接拒绝**（Claude/Codex）：我们的排队语义在单次调用内更友好，父 Agent 不需要处理重试，保留现有做法。
- **运行中 steer 子 Agent**：pi 的 `Agent.steer` 让它在技术上很便宜，但目前没有「父 Agent 中途改主意」的使用场景，也没有对应的 UI 入口，暂缓。

### 一个附带观察（不在本次范围内）

Claude Code 会对 subagent 输出做「指令形模式」扫描（[sub-agents#subagent-output-scanning](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)）。我们的 Subagent 会 Scrape 任意网页，存在提示注入沿 Subagent 结果传给父 Agent 的风险。目前 `<result>` 包裹没有任何转义：子 Agent 输出里如果含有 `</result>`，就能提前闭合标签。最低限度可以对 `</result` 做转义，这只需一行改动。
