# Agent Team 与预设编排：市场调研

> 调研日期：2026-11-19。问题：orqestra 要不要加 "Agent Team"（一组预设、会协作的 Agent），以及预设能不能让 Subagent 编排更稳。
>
> 只用一手来源：官方文档、官方博客、源码。源码链接固定到 commit SHA。标「推断」的句子没有直接出处。上一份调研 `docs/research/subagent-orchestration.md` 已覆盖 Claude Code subagent、Codex `spawn_agent`、OpenCode、Pi，本文不重复。
>
> 结构：A 节是 Claude 和 OpenAI，B 节是框架层（ADK、MAF、CrewAI、LangGraph），C 节是产品平台，D 节是对比表和横向结论，放在最前面。每个系统分五项：(a) 原语与数据形状，(b) 谁决定流程，(c) 通信，(d) 稳定性手段，(e) 官方承认的失败模式。
>
> 来源上的缺口：
> - `github.com/microsoft/agent-framework` 在调研当天对 `gh api` 返回 404（已复核），MAF 源码改从 PyPI sdist 读取，只钉到版本号。
> - cursor.com 无法直接抓取。Subagents 页用的是用户贴来的原文；Cursor 3 changelog、Agents Window、Cloud Agents API 三页只有搜索摘录。
> - 扣子旧版跳转模式只有一篇 2024 年的二手资料，已在 C 节注明。
> - 没有运行任何框架代码，行为全部来自文档和源码阅读。

## D. 横向结论

### D.1 对比表

| 系统 | 能预设什么 | 谁决定流程 | 通信 | 主要稳定性手段 | 官方承认的失败模式 |
|---|---|---|---|---|---|
| Claude Code agent teams | 只能预设角色（subagent 定义），team config 由运行时生成，不能手写（A.1） | lead 逐轮决定（LLM） | 共享任务列表（依赖、文件锁认领），每个 agent 一个 JSON 收件箱 | `TeammateIdle`、`TaskCreated`、`TaskCompleted` hook 拦截；建议 3 到 5 人 | 任务状态滞后，下游被卡；lead 提前收工、不等人；同文件互相覆盖；不能恢复会话，不能嵌套 |
| Claude Code dynamic workflows | 保存的 JS 脚本（`meta` 加 `agent`、`pipeline`、`parallel`、`phase`） | 脚本决定（由 LLM 写） | 只通过脚本变量传数据 | 禁用时间和随机保证可重放；schema 校验加 5 次重试；stall 自动重启；1000 agent 上限；运行前审批 | 中间一个失败，它之后已完成的也重跑；文件改动不回滚 |
| Claude Managed Agents | `predefined_agents` 名单：锁定版本、最多 20 个、只能一层，可关闭 inline agent | 用不用由 LLM 定；workflow 模式下由程序定 | 共享 sandbox，每个 thread 一条事件流 | session 级预算；Outcomes 独立 grader 按 rubric 评分；失败 agent 重跑一次 | run 显示 completed 不代表工作通过；可能执行两次，工具要幂等 |
| OpenAI Agents SDK | handoffs 列表、`as_tool` | 两种都给，官方说代码编排"more deterministic and predictable" | handoff 交出历史；as_tool 只传参数和结果 | `max_turns`；`output_type`；三类 guardrail 加 tripwire；tracing | guardrail 只管首个和末个 agent；handoff 不受 tool guardrail 约束 |
| Codex | 只能预设角色（`[agents]`） | LLM | mailbox 工具 | 开发中的 `rollout_budget`，整棵树共享 | 不建议并行写代码 |
| Google ADK | `sub_agents` 树；模板工作流（已 deprecated）；graph | AutoFlow 由 LLM 转移；graph 是确定的 | 共享 `session.state`、`output_key` | `max_llm_calls`=500；转移目标限定为 enum；schema；节点 retry/timeout | Loop 默认没上限；并行分支写 state 有竞态 |
| MAF / AutoGen | 五种预制编排加 Workflow 图 | 按图走，或由 manager 或选择函数决定 | 类型化消息加共享 State | 100 superstep；构建期图校验；checkpoint；Magentic 的 stall 计数后 replan | GroupChat 不设上限会一直跑；Magentic "untested outside original design" |
| CrewAI | Crew、Agent(role, goal, backstory)、Task(expected_output, guardrail)；Flow | sequential 按列表；hierarchical 由 manager LLM 决定；Flow 由开发者声明 | task 之间用 `context` 串联；coworker 工具 | `max_iter`；guardrail 重试；pydantic 输出；delegation 默认关 | 委派循环（官方承认）；manager 不委派，或委派给不存在的人 |
| LangGraph | StateGraph；supervisor/swarm 包 | 图定拓扑，LLM 用 `Command` 选边 | 共享图 state | checkpoint 加 pending writes；`recursion_limit`；RetryPolicy；`interrupt` | 官方说很多任务单 agent 就够；handoff 漏 ToolMessage 会弄坏历史 |
| Dify | 声明图，Agent 节点的 Output Routes | 图是声明的，LLM 只在声明过的出口里选 | 变量池 | 节点 retry 加 fail branch；500 步、3600 s、嵌套 5 层 | 路由选错时节点失败；loop 里一个子节点失败整个 loop 停 |
| Coze / 扣子 | 多 Agent 画布（每个节点写"适用场景"） | LLM 读描述决定移交；全局跳转条件优先 | 共享对话 | 节点重试、超时、默认输出、备用 LLM | 跳转不可靠（只有二手资料）；开源版只有单 Agent |
| Manus / OpenManus | 不预设角色，Wide Research 每项起一个通用 Manus | LLM | 只经主控制器；文件系统当记忆 | KV-cache 稳定、工具掩码、todo.md 复述；max_steps、卡死检测 | 不适合有顺序依赖的任务 |
| Cursor / pstack | Cursor：subagent .md（内置 Explore、Browser）；pstack：用文字 skill 写死阶段、角色模型和 judge | Cursor 由父 LLM 读 description 决定；pstack 由 LLM 照文字执行 | 干净上下文，只回传一条最终消息；默认共用父 checkout，可选 worktree 或云 VM | Cursor：嵌套最多 2 层，失败交回父 Agent 处理；pstack：结果契约（PASS/ISSUES/BLOCKED 加 SHA）、跨厂商 judge、返工换新 agent | 共用 checkout 时并行改文件会互相覆盖；description 含糊会派错（官方）；pstack 门禁没有运行时强制（推断） |
| Devin | Managed Devins；Python dynamic workflows | 协调者 LLM，或 LLM 写的脚本 | 完成即唤醒；JSON 输出；git 分支 | 按哈希录制并重放；schema；ACU 和 7 天上限；写操作单线程 | 并行写会做出互相冲突的隐含决策；协调者指令过细 |
| Kimi K2.5 | 不预设，用 `create_subagent` 现建 | 模型（RL 训练） | 子 Agent 输出作为观察回到编排者 | 奖励项压 serial collapse 和 spurious parallelism | 不加奖励项会退化成串行，或为刷指标狂开子 Agent |
| MiniMax Agent Team | Leader / Worker / Verifier 三种角色 | Leader（LLM）拆分；状态机按确定的代码转移 | whiteboard、notepad 文件，Agent 间 CLI | 对抗式 Verifier；test/lint/build 门禁 | 长任务漂移；edit-reject 循环空转；验证走过场 |

每格的出处在 A、B、C 三节对应条目里。

### D.2 哪些稳定性来自声明结构，哪些来自运行时

**来自声明结构**，有四类，每类都要在运行前写下来：

1. **限定"能交给谁"**：Managed Agents 的 `predefined_agents`（关闭 inline 后只能派名单内成员，A.3）；MAF 的 `add_handoff` 白名单、ADK 的 `disallow_transfer_to_*`、CrewAI 的"只有 manager 委派"（B 小结）；ADK 和 swarm 用 enum 防止 LLM 编造成员名（B）。这一类最接近"预设团队"，能挡住的是委派循环、委派给不存在的成员。
2. **固定阶段和拓扑**：Claude Code / Managed Agents / Devin 三家的 workflow 脚本（A.2、A.3、C Devin），ADK graph、MAF Workflow、LangGraph StateGraph、CrewAI Flow（B），Dify 图（C）。它们把"下一步跑谁"从 LLM 手里拿走。
3. **边界上的结构化输出**：`agent(prompt, {schema})`（A.2）、`output_type`（A.4）、Dify Output Routes（C）、pstack 的 PASS/ISSUES/BLOCKED 结果契约（C）。
4. **必须通过的验证门禁**：Managed Agents Outcomes（A.3）、`TaskCompleted` hook（A.1）、MiniMax Verifier（C）、pstack 跨厂商 judge（C）。MiniMax 和 pstack 都预设了角色，但 C 节的判断是：收益来自"必须过门禁"，不来自角色名字（推断）。

**来自运行时机制**，与有没有预设无关：

1. **整棵树共享的预算和硬上限**：Managed Agents session budget、Codex `rollout_budget`（A）；ADK `max_llm_calls`、MAF superstep 上限、LangGraph `recursion_limit`（B）；Dify 500 步、Devin 7 天（C）。
2. **卡住检测与重启**：Claude workflow stall 看门狗（A.2）、Magentic stall 计数后 replan（B）、OpenManus 重复内容检测（C）。
3. **可恢复**：按调用哈希重放（Claude workflow、Devin），superstep checkpoint（MAF、LangGraph）。前提都是副作用幂等，Managed Agents 和 LangGraph 都在文档里写明了这一点（A.3、B）。
4. **隔离**：每个子 Agent 一个新上下文和一份 worktree/VM（Manus、Devin、Cursor，C）；写操作单线程（Cognition，C）。
5. **通信可靠性**：mailbox 只在写成功时才算已发送、读时校验格式、任务认领加文件锁（A.1）；子任务完成即唤醒（Devin、MiniMax，C）。

### D.3 四个横向发现

1. **没有一家靠"预设一组成员"换来稳定。** 唯一叫 team 的 Claude Code agent teams 明确不让预先定义团队，只复用角色（[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)）；它的已知失败模式，即状态滞后、lead 提前收工、lead 不等人，都出在 LLM 自己协调这一环（[agent-teams#limitations](https://code.claude.com/docs/en/agent-teams#limitations)）。最接近"预设团队"的 Managed Agents `predefined_agents` 只预设成员名单，不规定成员之间怎么协作（[multiagent-orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration)）。另外，Claude Code workflows 页的对比表在 agent teams 一列写了"What's repeatable: The team definition"（[workflows#when-to-use-a-workflow](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)），和 agent-teams 页的说法对不上；按 agent-teams 页的说明，可复用的应当只是 subagent 定义（推断）。
2. **2026 年的收敛方向是"LLM 写脚本，运行时确定地执行"。** Claude Code dynamic workflows、Managed Agents workflow runs、Devin dynamic workflows 三家用的原语几乎相同：`agent()` 带 schema，加 `pipeline()` 和 `parallel()`，按记录重放，禁止依赖时间和随机（[workflows](https://code.claude.com/docs/en/workflows)，[Devin dynamic-workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)）。可以保存复用的"预设"是这段脚本，不是一组成员。
3. **框架层正在撤掉"让 LLM 自己组队"的高层封装。** `langgraph-supervisor` "is no longer actively maintained"，官方改推 subagent 即工具（[migrate/langgraph-supervisor.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/python/migrate/langgraph-supervisor.mdx#L11)）；ADK 把 Sequential/Parallel/Loop 模板标为 deprecated，改推 graph（[workflow-agents/index.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/index.md#L13)）；MAF 说 Magentic 在原设计之外"untested"（[magentic](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)）。
4. **主动不预设角色的一方同样能跑稳。** Manus Wide Research 每项起一个通用实例，Kimi K2.5 在运行时现建子 Agent（C 节）。它们的稳定性来自隔离、上下文工程和训练，不来自角色表。

### D.4 对 orqestra 的含义（全部是推断）

- orqestra 已经有的部分：Agent Definition 可以当作 Subagent 模板；Subagent 是异步的子 Conversation，有 Notification 和 Inbox；预算和深度在整棵树的根上计数（`GLOSSARY.md`「Subagent」「Inbox」，`docs/adr/0001-subagents-are-child-conversations.md`）。这已经覆盖了 Claude Code subagent 加命名消息的那部分能力。市场上的"team"在此之上多出两样东西：共享任务列表和成员之间的直接消息。按 Claude Code 自己的文档，这两样正是"状态滞后、lead 不等人"这类失败模式的来源。
- 如果要做"预设"，按上面 D.2 的分类，改动最小、市场证据最直接的是第 1 类：在 Agent Definition 上声明"它能派哪些 Agent Definition"（Managed Agents `predefined_agents`，以及上一份调研里的 OpenCode `permission.task` 和 Claude `Agent(x, y)`）。收益最大但成本也最大的是第 2 类：可保存、可重放的 workflow 脚本。
- `GLOSSARY.md` 在 Agent Definition 条目下把 "preset" 列为 _Avoid_。引入"Agent Team"之前，需要先确定它在领域模型里是一个新名词，还是 Agent Definition 上的一个字段。

## A. Claude 系与 OpenAI 系的 team / 多 Agent 原语（2026-11-19 核对）

本节只写 `docs/research/subagent-orchestration.md` 第 2 节没有的内容。OpenAI Agents SDK 的链接固定在 commit `91fb508`（v0.25.0），Codex 的固定在 `d64451b`。

### A.1 Claude Code agent teams（实验特性）

**(a) 原语与数据形状**
- 默认关闭，要设 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 才能用。`-p` 模式和 Agent SDK 会话都不会生成 teammate，带名字的 subagent 照旧按普通 subagent 跑。[agent-teams#enable-agent-teams](https://code.claude.com/docs/en/agent-teams#enable-agent-teams)
- 一个 team 由四部分组成：Team lead（主会话）、Teammates（各自独立的 Claude Code 实例）、Task list、Mailbox。[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- **团队不能预先声明**。`~/.claude/teams/{team}/config.json` 由运行时生成，里面有 `members[]`（name、agent ID、agent type，lead 固定为 `team-lead`）以及 session ID、tmux pane ID 等状态。文档明确说"不要手写或预先编写"，手改的内容会被覆盖；项目里的 `.claude/teams/teams.json` 也不会被识别。可复用的只有**角色**，即 subagent 定义。[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- team 名由会话派生，格式是 `session-` 加 session ID 前 8 位。session 结束时 config 目录被删，task 目录 `~/.claude/tasks/{team}/` 保留。[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- 触发方式：lead 调用 `Agent` 工具时只要带了 `name`，就会起一个 teammate（fork 和带 `isolation` 的调用除外），不需要用户确认。`AgentInput` 里的 `team_name` 已废弃且被忽略。[agent-teams#how-claude-starts-agent-teams](https://code.claude.com/docs/en/agent-teams#how-claude-starts-agent-teams)，[agent-sdk/typescript#agent](https://code.claude.com/docs/en/agent-sdk/typescript#agent)
- 任务的形状：`TaskCreate{subject, description, activeForm?, metadata?}`；`TaskUpdate{taskId, status: pending|in_progress|completed|deleted, owner?, addBlocks?, addBlockedBy?, ...}`。[agent-sdk/typescript#taskcreate](https://code.claude.com/docs/en/agent-sdk/typescript#taskcreate)
- 用 subagent 定义起 teammate 时，生效的字段有 `tools`（in-process 模式下会自动补上 `SendMessage` 和 Task 工具）、`model`、`disallowedTools`、`effort` 和 body；`skills` 不生效。[agent-teams#use-subagent-definitions-for-teammates](https://code.claude.com/docs/en/agent-teams#use-subagent-definitions-for-teammates)

**(b) 谁决定流程**：由 LLM 决定。用户用自然语言描述，"Claude decides the number of teammates"，lead 负责拆任务、分配和汇总。[agent-teams#specify-teammates-and-models](https://code.claude.com/docs/en/agent-teams#specify-teammates-and-models)，[workflows#when-to-use-a-workflow](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)（对比表："The lead agent, turn by turn"）

**(c) 通信**
- 共享任务列表：任务有 pending、in progress、completed 三种状态，可以声明依赖，依赖未完成时显示 blocked，teammate 不会自领 blocked 任务。领取有两种方式，lead 指派或 teammate 自领（做完一个就领下一个未分配、未阻塞的任务）。认领时用**文件锁**防止竞争。[agent-teams#assign-and-claim-tasks](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks)
- 依赖解除是自动的：上游任务完成后，下游任务随即 unblock。[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- Mailbox：每个 agent 一个 JSON 文件 `~/.claude/teams/{team}/inboxes/{agent}.json`。读取时逐条校验格式，不合格的条目会被删除并报错；只有写入收件人文件成功，才算发送成功。[agent-teams#architecture](https://code.claude.com/docs/en/agent-teams#architecture)
- 投递是自动的，lead 不需要轮询。teammate 停下时自动通知 lead 并附上最终答案；因 API 错误结束时也会通知，附错误文本。消息只能点对点发，没有广播，要群发就逐个发。[agent-teams#context-and-communication](https://code.claude.com/docs/en/agent-teams#context-and-communication)
- 结构化协议消息有 plan approval 和 shutdown request 两种，teammate 可以批准或拒绝 shutdown。[agent-teams#shut-down-teammates](https://code.claude.com/docs/en/agent-teams#shut-down-teammates)
- 上下文：teammate 能拿到 CLAUDE.md、MCP、skills 和 spawn prompt，**拿不到 lead 的对话历史**。[agent-teams#context-and-communication](https://code.claude.com/docs/en/agent-teams#context-and-communication)
- 信任边界：通过 SendMessage 收到的消息会被标成"来自另一个 Claude 会话"，不能替用户批准权限；auto mode 的分类器会先审查 agent 间的消息再投递。[agent-teams#messages-between-agents](https://code.claude.com/docs/en/agent-teams#messages-between-agents)

**(d) 稳定性手段**
- 质量门禁 hooks，三个都不支持 matcher，每次都触发：
  - `TeammateIdle`：exit 2 或 `{"decision":"block","reason"}` 会让 teammate 带着反馈继续工作；`{"continue":false}` 则强制它 idle。[hooks#teammateidle](https://code.claude.com/docs/en/hooks#teammateidle)
  - `TaskCreated`：block 时会删掉刚建的任务，并把 reason 作为工具错误返回。[hooks#taskcreated](https://code.claude.com/docs/en/hooks#taskcreated)
  - `TaskCompleted`：block 时任务保持未完成。它在两种时机触发，一是显式 `TaskUpdate` 为 completed，二是 teammate 结束回合时手上还有 in_progress 任务。文档给的示例是"测试不过不准完成"。[hooks#taskcompleted](https://code.claude.com/docs/en/hooks#taskcompleted)
- 计划审批：lead 处于 plan mode 时生成的 teammate 先只做计划。但如果没改过它的权限模式，计划会被**自动批准**，lead 并不审。[agent-teams#have-teammates-plan-before-implementing](https://code.claude.com/docs/en/agent-teams#have-teammates-plan-before-implementing)
- 权限：teammate 继承 lead 的模式（包括 bypass），生成时不能单独设置；它的权限提示会冒泡到 lead。[agent-teams#permissions](https://code.claude.com/docs/en/agent-teams#permissions)
- 规模建议：没有硬上限，推荐 3 到 5 个 teammate，每人 5 到 6 个任务。[agent-teams#choose-an-appropriate-team-size](https://code.claude.com/docs/en/agent-teams#choose-an-appropriate-team-size)

**(e) 已知失败模式**（官方列出）
- 任务状态滞后：teammate 忘了标 completed，阻塞了下游任务。
- `/resume` 和 `/rewind` 恢复不了 in-process teammate，lead 会给已不存在的 teammate 发消息。
- shutdown 慢。
- 每个 session 只能有一个 team；不能嵌套 team；lead 固定，不能转移。
- in-process teammate 不能起后台 subagent。
- 以上见 [agent-teams#limitations](https://code.claude.com/docs/en/agent-teams#limitations)。
- 遇错停下不恢复；lead 提前宣布完成；lead 自己动手而不等 teammate；两个 teammate 改同一文件导致覆盖。[agent-teams#troubleshooting](https://code.claude.com/docs/en/agent-teams#troubleshooting)，[agent-teams#wait-for-teammates-to-finish](https://code.claude.com/docs/en/agent-teams#wait-for-teammates-to-finish)，[agent-teams#avoid-file-conflicts](https://code.claude.com/docs/en/agent-teams#avoid-file-conflicts)
- 开启 teams 后，Claude 给 subagent 起名就会变成 teammate，团队可能"意外形成"。[agent-teams#claude-spawns-teammates-instead-of-subagents](https://code.claude.com/docs/en/agent-teams#claude-spawns-teammates-instead-of-subagents)
- token 成本随 teammate 数线性增长。[costs#agent-team-token-costs](https://code.claude.com/docs/en/costs#agent-team-token-costs)

### A.2 Claude Agent SDK / Claude Code：dynamic workflows（`Workflow` 工具）

Agent SDK 本身没有 team 原语，SDK 会话也不生成 teammate（见 A.1）。在 subagent 之外，SDK 和 Claude Code 新增的多 Agent 原语是 **dynamic workflow**。[workflows](https://code.claude.com/docs/en/workflows)，[agent-sdk/typescript#workflow](https://code.claude.com/docs/en/agent-sdk/typescript#workflow)

**(a) 原语与数据形状**
- 一个 workflow 是一段 JS 脚本，结构如下：
  - 开头是 `export const meta = {name, description, phases?}`（必须是字面量）。
  - 正文用 `agent(prompt, {schema?, label?, stallMs?, model...})`、`parallel()`、`pipeline(items, fn)`、`phase(title)`、`log()`，并读全局变量 `args`。
  - 可以保存到 `.claude/workflows/`，或随插件分发，之后作为 `/<name>` 命令复用。
  - [workflows#what-the-saved-script-looks-like](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like)，[workflows#edit-a-saved-script](https://code.claude.com/docs/en/workflows#edit-a-saved-script)
- 工具 I/O：
  - 输入 `WorkflowInput{script?|name?|scriptPath?, args?, resumeFromRunId?}`。
  - 输出 `{status: async_launched|remote_launched, taskId, runId, scriptPath, transcriptDir, error?}`，结果之后以 task completion 的形式到达。注意语法错误时 `status` 仍是 `async_launched`，同时 `error` 有值。
  - [agent-sdk/typescript#workflow](https://code.claude.com/docs/en/agent-sdk/typescript#workflow)

**(b) 谁决定流程**：脚本决定，即声明式代码。Claude 只负责**写**脚本，之后的循环、分支和中间结果都留在脚本变量里，不进 Claude 的上下文。[workflows#when-to-use-a-workflow](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)

**(c) 通信**：没有消息机制。数据由脚本在 agent 之间传递；运行期间不接受用户输入，需要人工签字的环节就拆成多个 workflow。[workflows#behavior-and-limits](https://code.claude.com/docs/en/workflows#behavior-and-limits)

**(d) 稳定性手段**
- **确定性重放**：脚本里调用 `Date.now()`、`Math.random()` 或无参 `new Date()` 会直接抛错，保证重跑时发出同样的 `agent()` 调用序列。[workflows#edit-a-saved-script](https://code.claude.com/docs/en/workflows#edit-a-saved-script)
- **可恢复**：重跑时按 agent 的启动顺序逐个处理：
  - 已完成且 prompt 未变的 agent 直接返回缓存结果。
  - 从第一个 prompt 变了的 agent 起，它及其后所有 agent 都重跑。
  - failed 的 agent 及其后的 agent 都重跑。
  - [workflows#which-agents-run-again](https://code.claude.com/docs/en/workflows#which-agents-run-again)
- **结构化输出**：`agent()` 可以带 JSON `schema`，启动前会静态检查 schema 是否自相矛盾；输出校验失败会重试 5 次（`MAX_STRUCTURED_OUTPUT_RETRIES`）。[workflows#what-the-saved-script-looks-like](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like)
- **stall 看门狗**：一段时间没有输出就从同一 prompt 重启，最多重启 5 次。第 6 次仍失败时，在 `parallel`/`pipeline` 里返回 `null`，直接 await 的会终止 run。该窗口同样适用于 workflow 之外的 subagent（`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`）。[workflows#when-an-agent-stalls-and-restarts](https://code.claude.com/docs/en/workflows#when-an-agent-stalls-and-restarts)
- **硬上限**：默认最多 16 个 agent 并发（可调到 1 至 256）；单次 `parallel`/`pipeline` 最多 4096 项，超出直接报错，避免静默截断；每个 run 最多 1000 个 agent。[workflows#behavior-and-limits](https://code.claude.com/docs/en/workflows#behavior-and-limits)
- **用量上限**：碰到 usage limit 时 run 会暂停，最多等两次，第三次就失败。[workflows#when-a-run-hits-your-usage-limit](https://code.claude.com/docs/en/workflows#when-a-run-hits-your-usage-limit)
- **启动前审批**：执行前展示 phase 列表和脚本供用户批准；SDK 和 `-p` 模式走权限规则 `Workflow(<name>)`。[workflows#approve-the-plan-before-it-runs](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs)
- **规模提醒**：超过 25 个 agent 或 150 万 token 时给出 `Large workflow` 警告，但只是提示。[workflows#cost](https://code.claude.com/docs/en/workflows#cost)
- **质量模式写进代码**：对抗式交叉审查、多角度起草等，以 `/deep-research` 为例，它会对每条论断投票，验证不了的标为 unverified，不算作 refuted。[workflows#run-a-bundled-workflow](https://code.claude.com/docs/en/workflows#run-a-bundled-workflow)

**(e) 已知限制**
- 中间某个 agent failed 时，它之后已完成的工作也会重跑。[workflows#which-agents-run-again](https://code.claude.com/docs/en/workflows#which-agents-run-again)
- stall 重启不会回滚已改的文件。[workflows#when-an-agent-stalls-and-restarts](https://code.claude.com/docs/en/workflows#when-an-agent-stalls-and-restarts)
- 退出 session 后 run 不会自己继续，要靠 Claude 再发一次 `Workflow` 调用才能重放。[workflows#resume-after-you-leave-the-session](https://code.claude.com/docs/en/workflows#resume-after-you-leave-the-session)
- 脚本不能 `import`，也不能直接访问文件系统。[workflows#behavior-and-limits](https://code.claude.com/docs/en/workflows#behavior-and-limits)

### A.3 Claude Managed Agents：`multiagent` 块（beta，`managed-agents-2026-04-01`）

**(a) 原语与数据形状**
- 写在 agent 定义里：
  ```json
  {"multiagent": {"type": "multiagent_20261001",
    "subagents": {"type": "enabled", "inline_agents": {...}, "predefined_agents": [...]},
    "workflows": {...},
    "advisor": {"type": "enabled", "model": "..."}}}
  ```
  `subagents` 和 `workflows` 默认开启，`advisor` 默认关闭。[multiagent-orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#turn-on-dynamic-workflows)
- `predefined_agents` 的条目可以是 `{"type":"agent","id","version?"}`、裸 id 或 `{"type":"self"}`。版本在创建或更新时**快照锁定**，被引用 agent 后续的更新不会自动生效。每个列表最多 20 个 agent。只能一层：被引用的 agent 如果自己带 `multiagent`，返回 400。[multiagent-orchestration#predefined-and-inline-agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents)，[#list-the-subagents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#list-the-subagents)
- 把 `inline_agents: {"type":"disabled"}` 设上，就只能用列出的 agent（白名单）。[multiagent-orchestration#predefined-and-inline-agents](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#predefined-and-inline-agents)
- 旧的 `coordinator` 类型只支持委派给列出的 agent 和 advisor。[#move-from-the-coordinator-type](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#move-from-the-coordinator-type)
- 运行时实体是 **session thread**：有 `parent_thread_id`、`workflow_run_id`、`agent`，以及独立的事件流 `/v1/sessions/{id}/threads/{tid}/stream`。[session-threads](https://platform.claude.com/docs/en/managed-agents/session-threads#list-threads)
- workflow run 的实体是 `wrun_…`，带 `phases[{id,name,description}]`，结束时 `result` 取值为 completed、stopped，或 error（细分 `timeout_error`、`program_error`、`thread_limit_error`、`unknown_error`）。[workflow-runs#run-events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events)

**(b) 谁决定流程**：三种模式都由 agent（LLM）决定**用不用**。subagent 模式下由 agent 逐轮决定下一步；workflow 模式下由 agent 写的程序决定，"The program determines which agents run next"。运行前没有审批步骤，"plan first"只能靠 prompt 约束，系统并不强制。[workflow-runs#how-dynamic-workflows-work](https://platform.claude.com/docs/en/managed-agents/workflow-runs#how-dynamic-workflows-work)，[multiagent-orchestration#tell-the-agent-when-to-use-a-run](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#tell-the-agent-when-to-use-a-run)

**(c) 通信**
- 所有 thread 共享同一个 sandbox、文件系统和 vault 凭证，各自保留独立的对话历史。[multiagent-orchestration#how-it-works](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#how-it-works)
- subagent 的 thread 是持久的，可以接着发消息。主线程上能看到 `agent.thread_message_sent/received`（带 `from/to_session_thread_id`、`content`）以及各 thread 的生命周期事件；需要客户端处理的 tool call 会被转发到主流。[session-threads#primary-thread-events](https://platform.claude.com/docs/en/managed-agents/session-threads#primary-thread-events)
- workflow 的 thread 没法接着发消息，由服务端自动归档；每个 thread 交给程序的结果也没有事件记录。[workflow-runs#a-runs-threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads)

**(d) 稳定性手段**
- **Session budget**：`{"type":"limit","max_list_cost":{"amount":"<cents>","currency":"USD"}}`，所有 thread 共用一个上限，在两次模型请求之间检查，超限后暂停，状态为 `budget_reached`。上限只能在创建 session 时设置。[budgets](https://platform.claude.com/docs/en/managed-agents/budgets#when-a-session-reaches-its-budget)，[#budgets-in-multiagent-sessions](https://platform.claude.com/docs/en/managed-agents/budgets#budgets-in-multiagent-sessions)
- **Outcomes**：发送 `user.define_outcome{description, rubric, max_iterations}` 后，系统会分配一个**独立上下文的 grader**，按 rubric 逐条评分，结果为 `satisfied`、`needs_revision`、`max_iterations_reached`、`failed` 或 `interrupted`，评不过就驱动 agent 再迭代。[define-outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes#outcome-evaluation-end)
- **Workflow 失败处理**：agent 失败时，服务端"usually"会在新 thread 上重跑一次。[workflow-runs#how-dynamic-workflows-work](https://platform.claude.com/docs/en/managed-agents/workflow-runs#how-dynamic-workflows-work)
- **Workflow 上限**：单个 run 内最多 64 个 thread 并发；一个 run 整个生命周期最多 1000 个 agent；默认寿命 24h；一个 session 同时最多开 10 个 run；run 不能嵌套。[workflow-runs#limits](https://platform.claude.com/docs/en/managed-agents/workflow-runs#limits)
- **线程上限**：每个 session 最多 25 个子线程，idle 的也算，归档后才释放名额。[session-threads](https://platform.claude.com/docs/en/managed-agents/session-threads#primary-thread-and-session-threads)
- **Advisor**：失败不会让当前回合失败。[multiagent-orchestration#how-consultations-work](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration#how-consultations-work)

**(e) 已知失败模式**（官方列出）
- run 的结果为 `completed` 并**不代表工作通过**，thread 失败了 run 照样可以 completed。[workflow-runs#run-events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events)
- 同一件工作可能被跑两次，工具要做到幂等。[workflow-runs#a-runs-threads](https://platform.claude.com/docs/en/managed-agents/workflow-runs#a-runs-threads)
- phase 的顺序和次数"API doesn't guarantee"。[workflow-runs#run-events](https://platform.claude.com/docs/en/managed-agents/workflow-runs#run-events)
- interrupt 不会结束 run，暂停期间 run 的寿命照样流逝。[workflow-runs#interrupt-a-session-with-runs-open](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open)
- session 变成 idle 不等于工作完成。[workflow-runs#know-when-the-work-is-done](https://platform.claude.com/docs/en/managed-agents/workflow-runs#know-when-the-work-is-done)
- 断线重连后事件不会回放，要自己 list 事件来重建状态。[workflow-runs#rebuild-run-state-after-you-reconnect](https://platform.claude.com/docs/en/managed-agents/workflow-runs#rebuild-run-state-after-you-reconnect)
- 被 interrupt 的子线程不会向父线程回报，父线程会一直等。[session-threads#interrupt-a-session-thread](https://platform.claude.com/docs/en/managed-agents/session-threads#interrupt-a-session-thread)

### A.4 OpenAI Agents SDK（Python v0.25.0）与 Agents API hosted multi-agent

**(a) 原语与数据形状**
- `Agent` 上与编排相关的字段：`handoffs`、`handoff_description`、`tools`、`output_type`、`input_guardrails`、`output_guardrails`、`tool_use_behavior`、`hooks`。[agents.md#L28-L45](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/agents.md#L28-L45)
- 两种组合模式。**Agents as tools**：由 manager 保持控制权，通过 `Agent.as_tool()` 调用其他 agent。**Handoffs**：目标 agent 接管本回合剩余部分。两者可以组合使用。[multi_agent.md#L22-L31](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/multi_agent.md#L22-L31)
- Handoff 对 LLM 而言就是一个名为 `transfer_to_<agent>` 的工具。`handoff()` 的参数：`agent`、`tool_name_override`、`tool_description_override`、`on_handoff`、`input_type`（handoff 参数的 schema，会在本地校验）、`input_filter`、`is_enabled`、`nest_handoff_history`。[handoffs.md#L5](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L5)，[#L32-L42](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L32-L42)
- `HandoffInputData` 的字段：`input_history`、`pre_handoff_items`、`new_items`、`input_items`、`run_context`。内置的 `handoff_filters.remove_all_tools` 会去掉工具相关条目。[handoffs.md#L112-L120](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L112-L120)
- `as_tool` 支持 `max_turns`、`run_config`、`session`、`needs_approval`、`parameters`（结构化入参）、`custom_output_extractor`。父 run 的对话状态**不会自动继承**到子 run。[tools.md#L730-L732](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/tools.md#L730-L732)
- Hosted 版本有两处入口：
  - Agents API 的 session 上设 `agent.multi_agent.enabled`，并发上限 `max_concurrent_subagents` 默认 6（不含 coordinator）；事件为 `create_subagent_call`、`send_subagent_input_call`、`wait_for_subagents_call`、`interrupt_subagent_call`。[agents-api/multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)
  - SDK 里对应的实验封装是 `OpenAIHostedMultiAgentModel(config={"max_concurrent_subagents"})`，走 beta `responses_multi_agent=v1`。[model.py#L44](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/extensions/experimental/hosted_multi_agent/model.py#L44)，[#L77-L86](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/extensions/experimental/hosted_multi_agent/model.py#L77-L86)

**(b) 谁决定流程**
- 官方把编排分成两类，"Orchestrating via LLM"和"Orchestrating via code"，并且明说用代码编排"more deterministic and predictable, in terms of speed, cost and performance"。[multi_agent.md#L3-L6](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/multi_agent.md#L3-L6)，[#L43-L50](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/multi_agent.md#L43-L50)
- 代码编排的推荐模式：用结构化输出做分类再路由；串成链；用 `while` 循环加 evaluator 做到通过为止；用 `asyncio.gather` 并行。[multi_agent.md#L45-L50](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/multi_agent.md#L45-L50)
- SDK **没有图或 workflow DSL**，"代码编排"就是普通 Python 代码。持久化执行交给外部集成（Temporal、Dapr、Restate、DBOS）。[running_agents.md#L575-L593](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/running_agents.md#L575-L593)

**(c) 通信**
- 没有消息总线，靠两种方式传递信息。handoff 时目标 agent 默认能看到完整历史，可以用 input filter 裁剪。as_tool 时子 run 只收到工具入参，输出以工具结果的形式返回。[handoffs.md#L110](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L112)，[tools.md#L732](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/tools.md#L732)
- 共享状态放在 `RunContextWrapper.context`，这部分是本地应用状态，不会发给模型。[handoffs.md#L101](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L105)
- Hosted 版本中，coordinator 和 subagent 共享 environment 的文件系统，但 hosted subagent 不能用 function tools。[agents-api/multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)

**(d) 稳定性手段**
- `max_turns`：默认 10，超出抛 `MaxTurnsExceeded`。[run_config.py#L45](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/run_config.py#L45)，[running_agents.md#L42](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/running_agents.md#L42)
- `error_handlers` 支持三个键：`max_turns`、`model_refusal`、`invalid_final_output`，用来返回可控的兜底输出。兜底输出要按 `output_type` 校验，SDK **不会重试**模型调用。[running_agents.md#L480](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/running_agents.md#L480)，[#L509](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/running_agents.md#L509)
- `output_type` 走 structured outputs；只有"文本输出符合类型且没有 tool call"才算 final output。[agents.md#L159-L183](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/agents.md#L159-L183)，[running_agents.md#L44-L46](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/running_agents.md#L44-L46)
- Guardrails 有三类：input、output、tool。触发 tripwire 会抛异常，直接停止执行。input guardrail 可以选并行或阻塞，阻塞模式下主 agent 不会启动。[guardrails.md#L10-L40](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/guardrails.md#L10-L40)，[#L84-L90](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/guardrails.md#L84-L90)
- Tracing 默认开启，层级是 trace → task / turn / agent / generation / function / guardrail / **handoff** span，并用 `group_id` 串起同一会话。[tracing.md#L15-L41](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/tracing.md#L15-L41)
- 一个回合里出现多个 handoff 时**只执行第一个**，其余返回 `"Multiple handoffs detected, ignoring this one."`，并在 span 上记一条错误。[turn_resolution.py#L581-L593](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/run_internal/turn_resolution.py#L581-L593)，[#L633-L643](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/run_internal/turn_resolution.py#L633-L643)
- `tool_use_behavior`（`stop_on_first_tool` 或 `StopAtTools`）可以让某个工具的结果直接作为最终输出，不再回到 LLM。[agents.md#L362-L370](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/agents.md#L362-L370)

**(e) 已知限制**
- 在 handoff 链里，input guardrail 只对第一个 agent 生效，output guardrail 只对最后一个生效，handoff 调用本身不受 tool guardrail 约束。[handoffs.md#L134-L136](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L134-L136)，[guardrails.md#L80](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/guardrails.md#L80)
- 并行 guardrail 触发时，主 agent 可能已经消耗了 token、执行了工具。[guardrails.md#L38](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/guardrails.md#L38)
- nested handoff history 仍是 opt-in beta，而且不会脱敏。[handoffs.md#L122-L124](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L122-L124)
- server-managed conversation 不支持 input filter。[handoffs.md#L130](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/docs/handoffs.md#L130)
- hosted multi-agent 不能和 SDK handoffs 或 `needs_approval` 一起用，原因是"active hosted response cannot be restored from serialized RunState"。[model.py#L390-L410](https://github.com/openai/openai-agents-python/blob/91fb508a8931016efa793b033147d08cd20308cf/src/agents/extensions/experimental/hosted_multi_agent/model.py#L390-L410)
- hosted 版本里，create 或 wait 动作完成并不代表 subagent 已完成任务，事件流里也没有完整的 transcript。[agents-api/multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)

### A.5 OpenAI Codex：spawn/wait 之外的新增

**(a) 原语与数据形状**
- **没有 team 或预设团队原语。** 自定义 agent 只有 `name`、`description`、`developer_instructions`，加上 model 相关的几个键；`sandbox_mode`、`approval_policy`、`mcp_servers` 写进 agent 文件也不会覆盖父会话的配置。[codex/subagents](https://developers.openai.com/codex/subagents)（Custom agent file schema 一节）
- `multi_agent` 这个 flag 现在是 **Deprecated**（仍默认开启），全局开关改成 `agents.enabled`。[features/src/lib.rs#L1700-L1711](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/features/src/lib.rs#L1700-L1711)，[codex/subagents](https://developers.openai.com/codex/subagents)
- v2 的系统提示把 root 称为"`/root`, the primary agent in a team of agents"，说明子 agent 可以继续嵌套生成，默认 4 个并发槽位（含自己），所有 agent 共享同一 cwd。[测试快照](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/core/tests/suite/snapshots/all__suite__scenarios__agent_message_board__remote__remote_board_tools.snap)
- **Agent message board**（UnderDevelopment，默认关闭）：给整棵 agent 树提供共享讨论工具，形态是频道加帖子加订阅，可以用 `agents_to_notify` 定向通知。工具包括 create/upsert channel、list threads、search、read、subscribe、post、append。连接可以设成只读，posting 有会话内去重，单次响应上限 8000 字节。另有 MCP 版 `agent_message_board_mcp`。[lib.rs#L1749-L1759](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/features/src/lib.rs#L1749-L1759)，[message-board/src/tools/spec.rs](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/message-board/src/tools/spec.rs)，[message-board-mcp/README.md](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/message-board-mcp/README.md)，[ext/agent-message-board/README.md](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/ext/agent-message-board/README.md)
- **已删除的 agent jobs**：`spawn_agents_on_csv` 和 `report_agent_job_result` 于 2026-07-20 删除，表也一并 drop。原来的数据形状是：
  - `agent_jobs{instruction, output_schema_json, input_csv_path, output_csv_path, status, last_error}`
  - `agent_job_items{row_json, status, assigned_thread_id, attempt_count, result_json}`
  - 这是一个由**数据声明**的扇出：每行 CSV 起一个 agent，带输出 schema 和重试计数。
  - [commit 687f05c](https://github.com/openai/codex/commit/687f05cb946d10c96f90dd7ce82e11465c6e20a7)，[0014_agent_jobs.sql](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/state/migrations/0014_agent_jobs.sql)，[0042_drop_agent_jobs.sql](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/state/migrations/0042_drop_agent_jobs.sql)
- **Codex Cloud best-of-N**：`--attempts` 取 1 到 4，之后用 `apply --attempt N` 选一份结果应用。[cloud-tasks/src/cli.rs#L39-L60](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/cloud-tasks/src/cli.rs#L39-L60)，[#L106-L108](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/cloud-tasks/src/cli.rs#L106-L108)

**(b) 谁决定流程**：由 LLM 决定。"ChatGPT or Codex handles orchestration across agents"，本地版只在用户直接要求或项目、skill 指令要求时才生成 agent。[codex/subagents](https://developers.openai.com/codex/subagents)（Orchestration and thread controls 一节）

**(c) 通信**：mailbox 方式（已有文档覆盖）。另有两个开发中的 flag：`defer_mailbox_preemption`，新邮件推迟到下一个输入边界再投递；`wake_on_agent_messages`，agent 消息可以唤醒已 idle 的 root。[lib.rs#L1736-L1747](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/features/src/lib.rs#L1736-L1747)

**(d) 稳定性手段**：`rollout_budget`（UnderDevelopment）跨整棵 agent 树共享 token 预算。每个 thread 开始新工作前都要经过同一个 work gate；超过阈值的提醒会逐 thread 投递。[lib.rs#L2325-L2329](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/features/src/lib.rs#L2325-L2329)，[core/src/rollout_budget.rs#L25-L80](https://github.com/openai/codex/blob/d64451b049d6f8b75b747e339a7034d23ddc9466/codex-rs/core/src/rollout_budget.rs#L25-L80)

**(e) 已知限制**
- web 侧栏只能看，不能单独停止或引导某个 subagent。[codex/subagents](https://developers.openai.com/codex/subagents)（Managing subagents 一节，据检索摘要，未逐字核对）
- 官方提醒：并行写代码会产生冲突，建议并行只用于读多写少的任务。[codex/subagents](https://developers.openai.com/codex/subagents)（Why subagent workflows help 一节）
- CSV 扇出被删的原因，commit 里没写。**推断**：与 v2 的 task-path 路由重叠。

### A.6 小结：稳定性收益来自哪里

**来自声明式结构**（预设、脚本、配置）：
- Claude workflow 脚本：流程不再由 LLM 逐轮决定；禁用随机和时间以保证确定性重放；缓存可恢复；每个 `agent()` 都可以带 schema；phase 事先声明并供审批；保存后可以作为命令复用。
- Managed Agents 的 `predefined_agents`：版本锁定、白名单（关闭 inline）、只允许一层。这是最接近"预设团队"的原语，但它预设的只是**可用成员名单**，不规定协作流程。
- OpenAI 的 code orchestration：官方明说代码编排更可预测。`output_type` 加代码路由、evaluator 循环、`input_type` 的 schema 校验都属于这一类。
- Codex 已删除的 CSV agent jobs：按行声明扇出，带输出 schema 和 attempt 计数。

**来自运行时机制**（与有没有预设无关）：
- 预算与上限：Managed Agents 的 session budget；Codex 的 `rollout_budget`；OpenAI 的 `max_turns`；各家的并发、深度和总数上限。
- 验证与门禁：Claude Code 的 `TaskCompleted`、`TeammateIdle`、`TaskCreated` hooks；Managed Agents 的 Outcomes（独立 grader 按 rubric 评分并驱动迭代）；OpenAI 的 guardrails 和 tripwire。
- 故障恢复：workflow 的 stall 重启；Managed Agents 失败 agent 重跑一次；结构化输出 5 次重试；OpenAI 的 `error_handlers` 兜底。
- 通信可靠性：mailbox 只在写成功时才报告已发送，读取时校验格式；认领任务用文件锁；依赖自动解除；多个 handoff 时只执行第一个。

**结论**：
- 唯一叫"team"的原语是 Claude Code agent teams，它在文档里明确**不支持预定义团队**（config 是运行时生成的，不能手写），流程仍由 lead 逐轮决定。它的稳定性来自 hooks 和任务列表机制，而官方列出的失败模式（状态滞后、提前收工、lead 不等人）恰恰是 LLM 自己协调造成的。
- 各家要提高稳定性，走的路是"把流程写成代码"（Claude workflow、Managed Agents workflow runs、OpenAI 的 code orchestration），而不是"预设团队成员"。**推断**：只预设成员、不声明流程，对稳定性帮助有限；收益主要来自声明式流程，加上运行时的预算和门禁。

## B. 框架层：Google ADK / Microsoft Agent Framework(+AutoGen) / CrewAI / LangGraph

调研日 2026-11-19。源码链接都钉在 commit SHA 或 PyPI 版本上。没有出处的句子标 **推断**。

钉住的版本：
- ADK 文档 `google/adk-docs@71d9608`；ADK Python 源码 `google/adk-python@e2a21ac`
- MAF：`github.com/microsoft/agent-framework` 今天对 `gh api` 和 `curl` 都返回 HTTP 404（见下），所以源码取自 PyPI sdist [`agent-framework-core 1.26.0`](https://pypi.org/project/agent-framework-core/1.26.0/) 和 [`agent-framework-orchestrations 1.4.2`](https://pypi.org/project/agent-framework-orchestrations/1.4.2/)；AutoGen 取自 `microsoft/autogen@8390985`
- CrewAI `crewAIInc/crewAI@a143512`（docs/edge）
- LangChain 文档 `langchain-ai/docs@e4c62bf`；`langgraph@292106d`；`langgraph-supervisor-py@88859b3`；`langgraph-swarm-py@8956b13`

### Google ADK

**(a) 原语与数据形状**
- 每个 agent 都有 `BaseAgent.description` 和 `sub_agents: list[BaseAgent]`，组成一棵树（[base_agent.py L161/L180](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/agents/base_agent.py#L161-L180)）。
- `LlmAgent` 的协作字段（[llm_agent.py L331-L460](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/agents/llm_agent.py#L331-L460)）：`global_instruction`、`mode`、`disallow_transfer_to_parent`、`disallow_transfer_to_peers`、`include_contents: 'default'|'none'`、`input_schema`、`output_schema`，以及 `output_key`（[llm_agent_config.py L107-L128](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/agents/llm_agent_config.py#L107-L128)）。
- 控制信号放在事件上。`EventActions` 有四个字段（[event_actions.py L126-L163](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/events/event_actions.py#L126-L163)）：`state_delta: dict`、`transfer_to_agent: str|None`、`escalate: bool|None`、`end_of_agent`。
- `transfer_to_agent(agent_name, transfer_reason)` 是一个工具，作用只是写 `actions.transfer_to_agent`（[transfer_to_agent_tool.py L49-L74](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/tools/transfer_to_agent_tool.py#L49-L74)）。
- `AgentTool(agent, skip_summarization, include_plugins, propagate_grounding_metadata)` 把一个 agent 包成工具（[agent_tool.py L149-L184](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/tools/agent_tool.py#L149-L184)）。
- 模板工作流：`SequentialAgent`、`ParallelAgent`、`LoopAgent(max_iterations)`。三者已标 **Deprecated**，官方说它们"被 graph-based / dynamic workflows 取代"（[workflow-agents/index.md L13](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/index.md#L13)）。
- ADK 2.0 的新原语：
  - Graph workflow：节点加边，节点可以是 LlmAgent、函数、人工输入或工具（[graphs/index.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/graphs/index.md)）。
  - "Collaborative agent team"：coordinator 加带 `mode` 的 subagent（`chat`/`task`/`single_turn`）。ADK 会给每个 subagent 自动注入一个同名的委派工具（[workflows/collaboration.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/workflows/collaboration.md)）。
- A2A：用 `RemoteA2aAgent(BaseAgent)` 把远端 agent（按 Agent Card 描述）当作本地 sub-agent 用（[_remote_a2a_agent.py L1070](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/a2a/agent/_remote_a2a_agent.py#L1070)，[a2a/intro.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/a2a/intro.md)）。

**(b) 谁决定流程**
- 两条路线并存。
- LLM 驱动的一条是 `AutoFlow`。它允许三个方向的转移：父到子、子到父、同级之间。同级转移有两个前提：父节点也是 LlmAgent，且 `disallow_transfer_to_peers=False`（[auto_flow.py L23-L40](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/flows/llm_flows/auto_flow.py#L23-L40)）。
- 声明式的一条是模板工作流和 graph。官方明确说模板工作流"不由 AI 模型控制，执行是确定的"（[loop-agents.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/loop-agents.md)）。graph 被宣传为"Enhance reliability… relying on structured node definitions rather than prompts alone"（[graphs/index.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/graphs/index.md)）。
- 2.0 的 `task`/`single_turn` 模式介于两者之间：同一个 agent 作为图节点时，跑完推进到下一节点；被 LlmAgent 委派时，跑完自动回到委派方（[collaboration.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/workflows/collaboration.md)）。

**(c) 通信**
- 主通道是共享 `session.state`。
  - `output_key` 把 agent 的最终文本写进 state，`{key}` 把 state 注入下一个 agent 的 instruction。
  - key 有作用域前缀 `user:`、`app:`、`temp:`。
  - 官方警告：不要直接改 `SessionService` 取出来的 `session.state`，这样会绕过事件追踪、可能丢数据（[sessions/state.md L306](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/sessions/state.md#L306)）。
- `ParallelAgent` 的各分支之间不自动共享对话历史，但共享同一个 session state；事件顺序不确定；官方建议各分支写各自的 `output_key`（[parallel-agents.md L36](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/parallel-agents.md#L36)）。
- 2.0 的 task/single_turn agent 各跑在隔离的 session branch 上，看不到同级在做什么，全部完成后结果才汇总给父节点（[collaboration.md L203](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/workflows/collaboration.md#L203)）。

**(d) 稳定性手段**
- 全局 LLM 调用预算：`RunConfig.max_llm_calls` 默认 500，可用环境变量 `ADK_MAX_LLM_CALLS` 覆盖。设成 ≤0 会告警"could result in a never ending communication"，超限抛 `LlmCallsLimitExceededError`（[run_config.py L37/L268/L357-L370](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/agents/run_config.py#L357-L370)，[invocation_context.py L65-L95](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/agents/invocation_context.py#L65-L95)）。
- 转移目标用 JSON Schema enum 约束：`TransferToAgentTool` 的注释写明是为了"prevents LLMs from hallucinating invalid agent names"（[transfer_to_agent_tool.py L68-L74](https://github.com/google/adk-python/blob/e2a21ac23260d043bf9d217b573af1bef48f0f70/src/google/adk/tools/transfer_to_agent_tool.py#L68-L74)）。
- 结构化 I/O：`input_schema`、`output_schema`。
- 用 `include_contents='none'` 切断历史注入。
- graph 节点可以配 retry policy 和 timeout，失败时用同样的输入重跑；只有用尽次数后，失败才传到整个工作流（[graphs/retry.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/graphs/retry.md)）。
- 回调（before/after model、tool）可以拦截（[llm-agents.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/llm-agents.md)）。

**(e) 已知失败模式与限制**
- `LoopAgent` 自己不判断何时停。Python 版 `max_iterations` 默认 `None`，此时只有 escalate 能让循环停下，需要使用者自己防无限循环（[loop-agents.md L43](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/loop-agents.md#L43)）。
- 并行分支并发写 state 有竞态，官方说"do not rely on one branch reading a key another branch is still writing"（[parallel-agents.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/agents/workflow-agents/parallel-agents.md)）。
- 有些内置工具（Code Execution、Google Search 等）不能和其他工具放进同一个 agent，放进 sub_agents 也不行（[tools/limitations.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/tools/limitations.md)）。
- `AgentTool` 默认不把被包 agent 的 grounding metadata 带回调用方（[limitations.md](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/tools/limitations.md)）。
- 2.0 的限制：`task` 模式的 agent 必须是叶子节点；`task` 模式在 ADK Python 2.0.0 的 graph 里暂时被禁用（[collaboration.md L211](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/workflows/collaboration.md#L211)）。
- A2A 只适合跨进程、跨团队部署。官方点名以下场景应该用本地 sub-agent：内部代码组织、低延迟场景、需要共享内存或上下文的场景（[a2a/intro.md L47](https://github.com/google/adk-docs/blob/71d96088cd26d4fa4529c464b6403079bf21f9d7/docs/a2a/intro.md#L47)）。

### Microsoft Agent Framework（MAF），以及 AutoGen

先说状态：
- AutoGen 仓库已归档："archived and no longer maintained… New users should start with Microsoft Agent Framework"（[autogen README L19-L29](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/README.md#L19-L29)）。
- MAF 在 PyPI 上的 `project_urls` 仍然指向 `github.com/microsoft/agent-framework`，但今天 `curl -sI` 这个地址返回 404（实测）。原因不明：可能改名、转私有，也可能是临时故障（**推断**）。

**(a) 原语与数据形状**
- 底层是 Workflow：`Executor` 加 `Edge`/`EdgeGroup`，边组有 `Single`、`FanOut`、`FanIn`、`SwitchCase`、多选几种；builder 方法有 `add_edge`、`add_fan_out_edges`、`add_fan_in_edges`、`add_switch_case_edge_group`、`add_multi_selection_edge_group`、`add_chain`（sdist `agent_framework/_workflows/_edge.py`、`_workflow_builder.py` L227-L563）。
- 上层有五种预制编排（[orchestrations 总览](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/)）：Sequential、Concurrent、Handoff、GroupChat、Magentic，对应 `SequentialBuilder`、`ConcurrentBuilder`、`HandoffBuilder`、`GroupChatBuilder`、`MagenticBuilder`（[PyPI orchestrations 摘要](https://pypi.org/project/agent-framework-orchestrations/1.4.2/)）。
- Magentic 的数据形状：
  - `MagenticProgressLedger` 有五个字段：`is_request_satisfied`、`is_in_loop`、`is_progress_being_made`、`next_speaker`、`instruction_or_question`，每项是 `{answer, reason}`。
  - `MagenticContext` 有 `round_count`、`stall_count`、`reset_count`。
  - builder 参数：`max_stall_count=3`、`max_reset_count`、`max_round_count`、`progress_ledger_retry_count=3`、`enable_plan_review`。
  - 出处：sdist `_magentic.py` L292-L398、L492-L606。
- GroupChat 的 LLM 编排器输出 `AgentOrchestrationOutput{terminate, reason, next_speaker, final_message}`，是一个结构化 Pydantic 对象（`_group_chat.py` L263-L282）。
- AutoGen 的 team 原语：`RoundRobinGroupChat`、`SelectorGroupChat(max_turns, allow_repeated_speaker=False, max_selector_attempts=3, selector_func, candidate_func)`、`Swarm`（按 `HandoffMessage.target` 选下一位）、`MagenticOneGroupChat(max_turns=20, max_stalls=3)`（[_selector_group_chat.py L605-L616](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_selector_group_chat.py#L605-L616)，[_magentic_one_group_chat.py L117-L119](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_group_chat.py#L117-L119)）。

**(b) 谁决定流程**
- Workflow、Sequential、Concurrent 由声明的图决定。
- GroupChat 是中心化的：由 `selection_func` 或编排 agent 选下一位发言者。
- Handoff 是去中心化的：agent 调 `handoff_to_<id>` 工具自行路由，没有中心编排者，`add_handoff` 限定谁能交给谁（`_handoff.py` 模块 docstring L1-L30，[handoff 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- Magentic 由 manager LLM 每轮产出 progress ledger，决定下一位和给它的指令（[magentic 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)）。

**(c) 通信**
- Workflow 内部走类型化消息加共享 State，按 Pregel superstep 运行。State 在 superstep 边界 commit，同一 superstep 里的执行器看到的是同一份已提交状态（sdist `_state.py` L12-L44，`_runner.py` L45-L185）。
- Handoff 的各参与者不共享同一个 `AgentSession`，而是每次产出后把用户和 agent 的消息广播给所有人。工具调用和 handoff 调用不广播（[handoff 文档 Context Synchronization](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- Magentic 和 GroupChat 共用一份 chat history，task ledger 作为一条消息追加进去（`_magentic.py` L1176-L1224）。

**(d) 稳定性手段**
- 运行时收敛上限：`DEFAULT_MAX_ITERATIONS = 100` 个 superstep，未收敛就抛 `WorkflowConvergenceException`（sdist `_const.py` L4，`_runner.py` L184-L185）。
- 构建期图校验：边重复、类型兼容、连通性、自环、死端（`_validation.py` L42-L415）。
- 每个 superstep 结束时写 checkpoint，内容包括执行器状态、待投递消息、待处理请求、共享状态；1.13 起入口也写 checkpoint，整次运行可回放。存储有 InMemory、File、Cosmos 三种。restore 要求拓扑和执行器 ID 稳定（[checkpoints 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints)）。
- Magentic 的停滞检测：
  - 某一轮 `!is_progress_being_made || is_in_loop` 就 `stall_count+=1`，否则减 1；超过 `max_stall_count` 就 reset 所有参与者并 replan（`_magentic.py` L1153-L1224）。
  - 到达 round 或 reset 上限就以"terminated due to reaching maximum … count"结束（L1281-L1300）。
  - ledger 的 JSON 解析失败最多重试 3 次（L740-L771）。
  - `next_speaker` 不在参与者里就直接进入最终汇总（L1171-L1174）。
- HITL：Magentic 的 plan review（Python 默认关，.NET 默认开）；`approval_mode="always_require"` 的工具会暂停并发 `request_info`（[magentic 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)，[handoff 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- Handoff autonomous 模式：每个 agent 默认最多 50 轮，可配 `termination_condition`（`_handoff.py` L238/L490-L500）。
- GroupChat：`selection_func` 返回未知参与者直接抛错（`_group_chat.py` L252-L253）；编排 agent 有 `retry_attempts`（L310-L561）。
- AutoGen Selector 的重试链：
  - 模型没给出名字、给了多个名字、或选了上一位发言者时，带反馈重问，最多 `max_selector_attempts` 次。
  - 仍失败就回退到上一位发言者，或第一个参与者（[L232-L308](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_selector_group_chat.py#L232-L308)）。
- AutoGen MagenticOne 编排器：`max_stalls`、`max_turns`，ledger JSON 重试 10 次（[_magentic_one_orchestrator.py L92-L351](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py#L92-L351)）。
- AutoGen 终止条件是可组合的组件：MaxMessage、TextMention、TokenUsage、Handoff、Timeout、External、SourceMatch、FunctionCall 等（[_terminations.py](https://github.com/microsoft/autogen/blob/8390985108cb1e3881f5f7297765758d8ad2540c/python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py)）。

**(e) 已知失败模式与限制**
- GroupChat 不设 `max_rounds` 或 `termination_condition` 时，"will continue indefinitely"（`_group_chat.py` L143-L144）。
- Magentic 官方原话："it is untested how well the Magentic orchestration will perform outside of the original Magentic-One design"。官方建议简单协作改用 GroupChat；有状态的 `manager` 不要跨并发工作流共享（[magentic 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)）。
- Handoff 天生需要交互：agent 不调 handoff 工具时，工作流"won't know what to do next"，只能把控制交回用户。autonomous 模式是 experimental，而且官方说无法强制 agent 每轮都 handoff（[handoff 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- Handoff 只支持本地执行工具的 `Agent`（[同上](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)）。
- checkpoint 是信任边界（pickle，用受限 unpickler）。重建时 agent 的 `Id` 和 `Name` 必须稳定，否则 checkpoint 不兼容（[checkpoints 文档](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints)）。

### CrewAI

**(a) 原语与数据形状**
- `Crew` 的主要字段（[crews.mdx L23-L43](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/crews.mdx)）：`agents`、`tasks`、`process`（默认 sequential）、`manager_llm`、`manager_agent`、`max_rpm`、`memory`、`cache`、`planning`、`planning_llm`、`checkpoint`、`skills`、`before_kickoff_callbacks`、`after_kickoff_callbacks`。输出是 `CrewOutput{raw, pydantic, json_dict, tasks_output, token_usage}`。
- `Agent` 的主要字段（[agents.mdx L49-L53](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/agents.mdx)）：`role`、`goal`、`backstory`、`max_iter=20`、`max_rpm`、`max_execution_time`、`allow_delegation=False`、`max_retry_limit=2`、`respect_context_window=True`、`reasoning`、`planning_config`。
- `Task` 的主要字段（[tasks.mdx L63-L67](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/tasks.mdx)）：`description`、`expected_output`、`agent`、`tools`、`context: list[Task]`、`async_execution`、`human_input`、`output_json`、`output_pydantic`、`guardrail`、`guardrails`、`guardrail_max_retries=3`。
- `Process` 是枚举，只有 `sequential` 和 `hierarchical` 两个值（[processes.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/processes.mdx)）。
- `Flow[State]`：`@start`、`@listen(or_/and_)`、`@router(emit=[...])`、`@human_feedback`、`@persist`；state 可以是 dict 或 Pydantic，带自动 UUID（[flows.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/flows.mdx)）。

**(b) 谁决定流程**
- sequential：按 task 列表顺序执行，前一个的输出作为后一个的上下文（[processes.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/processes.mdx)）。
- hierarchical：task 不预先分配，由 manager 按能力分派、审结果、判断完成（[processes.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/processes.mdx)）。
  - 只给 `manager_llm` 时，框架自建一个 manager，工具只有 `AgentTools(agents)` 的两个委派工具。
  - 自定义 `manager_agent` 如果带了其他工具，直接抛 "Manager agent should not have tools"（[crew.py L1542-L1569](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/lib/crewai/src/crewai/crew.py#L1542-L1569)）。
  - `manager_agent` 不能同时出现在 `agents` 里（[crew.py L736-L752](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/lib/crewai/src/crewai/crew.py#L736-L752)）。
- Flows 由开发者声明事件图。官方定位是"Flows: The Backbone… Crews: units of work within your Flow"（[introduction.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/introduction.mdx)）。

**(c) 通信**
- Task 之间：显式的 `context` 输出串联。
- Agent 之间：`allow_delegation=True` 时注入两个工具，`Delegate work to coworker(task, context, coworker)` 和 `Ask question to coworker(question, context, coworker)`（[collaboration.mdx L44-L59](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/collaboration.mdx#L44-L59)）。
- Flow 之间：共享 `self.state`。
- Crew 级 memory 和 knowledge sources 所有 agent 都能读（[crews.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/crews.mdx)）。

**(d) 稳定性手段**
- 预算类：
  - `max_iter=20`，到上限必须给出 best answer。
  - `max_execution_time`、`max_rpm`、`max_retry_limit=2`。
  - `respect_context_window`：超窗时自动摘要（[agents.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/agents.mdx)）。
- 校验类：
  - Task guardrail 在进入下一个 task 前校验输出，失败重试，默认 3 次。
  - `output_pydantic`、`output_json` 做结构化输出（[tasks.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/tasks.mdx)）。
- 规划类：
  - `Crew(planning=True)` 在开跑前让 CrewPlanner 给每个 task 写计划，追加进 task 描述。
  - Agent 级的 `PlanningConfig` 让 agent 先写计划，再逐步执行、逐步检查（[planning.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/planning.mdx)）。
- 持久化：Crew 有 `checkpoint`；Flow 的 `@persist` 默认用 SQLite，支持 resume（同一 UUID）和 fork（`restore_from_state_id`）（[flows.mdx L408-L452](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/flows.mdx#L408-L452)）。
- 结构默认值：`allow_delegation` 默认 False，官方称之为"to give users explicit control"（[hierarchical-process.mdx](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/learn/hierarchical-process.mdx)）。

**(e) 已知失败模式与限制**
- 官方 troubleshooting 列了三类问题（[collaboration.mdx L269-L303](https://github.com/crewAIInc/crewAI/blob/a1435129057cb9aee5ead3f1272d25d3c84497b5/docs/edge/en/concepts/collaboration.mdx#L296)）：
  - "Delegation Loops：Agents delegate back and forth indefinitely"。给的解法是结构性的：只有 manager 能委派，specialist 设 `allow_delegation=False`。
  - "Too Much Back-and-Forth"。
  - "Agents Not Collaborating"。
- 以下是 GitHub issue 里的 hierarchical 实际故障：
  - manager 从不委派，自己用工具干完，退化成 sequential（[#4783](https://github.com/crewAIInc/crewAI/issues/4783)）。
  - manager 委派给不存在的 coworker，报 "coworker mentioned not found"（[#1399](https://github.com/crewAIInc/crewAI/issues/1399)，[#1823](https://github.com/crewAIInc/crewAI/issues/1823)）。
  - 同一个 crew 第二次 kickoff 时，manager 崩溃或委派给自己（[#8368](https://github.com/crewAIInc/crewAI/issues/8368)，已关）。
  - hierarchical crew 从 checkpoint 恢复失败（[#8645](https://github.com/crewAIInc/crewAI/issues/8645)，仍 open）。
  - 换语言后 hierarchical 行为不同（[#3925](https://github.com/crewAIInc/crewAI/issues/3925)）。

### LangGraph / LangChain multi-agent

先说状态：
- `langgraph-supervisor` 已不再积极维护，官方迁移目标是 subagents 模式，即 `create_agent` 加"把 worker 包成 `@tool`"（[migrate/langgraph-supervisor.mdx L11](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/python/migrate/langgraph-supervisor.mdx#L11)；README 也写着"We now recommend using the supervisor pattern directly via tools rather than this library"，见 [supervisor README L3](https://github.com/langchain-ai/langgraph-supervisor-py/blob/88859b34017ac3569bbd4a3092c7e77593a0a960/README.md#L3)）。
- `langgraph-swarm` 的 README 没有弃用声明（实测）。

**(a) 原语与数据形状**
- `StateGraph(State)`：节点加边加条件边。
- `Command(goto, update, graph=Command.PARENT, resume)`：在节点内同时改 state 和路由（[types.py L843-L892](https://github.com/langchain-ai/langgraph/blob/292106d22302cbeb27725a61d91848bd0fd19459/libs/langgraph/langgraph/types.py#L843-L892)）。
- `RetryPolicy(max_attempts=3, …)` 挂在节点上（[types.py L428-L440](https://github.com/langchain-ai/langgraph/blob/292106d22302cbeb27725a61d91848bd0fd19459/libs/langgraph/langgraph/types.py#L428-L440)）。
- supervisor：`create_supervisor(agents, model, response_format, parallel_tool_calls=False, output_mode="last_message"|"full_history", add_handoff_messages=True, handoff_tool_prefix, add_handoff_back_messages, supervisor_name)`（[supervisor.py L217-L339](https://github.com/langchain-ai/langgraph-supervisor-py/blob/88859b34017ac3569bbd4a3092c7e77593a0a960/langgraph_supervisor/supervisor.py#L217-L339)）。
- swarm：`SwarmState(MessagesState){active_agent: str|None}`；构建时把 `active_agent` 改写成 agent 名的 `Literal`（[swarm.py L13-L47](https://github.com/langchain-ai/langgraph-swarm-py/blob/8956b138bbb475b00c98d040176dbb8da667c612/langgraph_swarm/swarm.py#L13-L47)）。
- swarm 的 handoff 工具返回 `Command(goto=agent_name, graph=Command.PARENT, update={messages:[…, ToolMessage("Successfully transferred…")], active_agent})`（[handoff.py L80-L93](https://github.com/langchain-ai/langgraph-swarm-py/blob/8956b138bbb475b00c98d040176dbb8da667c612/langgraph_swarm/handoff.py#L80-L93)）。
- LangChain 当前的五种模式：Subagents、Handoffs、Skills、Router、Custom workflow（[multi-agent/index.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/index.mdx)）。

**(b) 谁决定流程**
- 图拓扑由声明决定；节点内由 LLM 通过工具调用 `Command` 选边。
- Subagents/supervisor：所有路由都经过主 agent。
- Handoffs：工具调用改写一个 state 变量，由它触发路由（[index.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/index.mdx)）。
- swarm 靠 `active_agent` 记住上次活跃的 agent，下一轮从它开始（[swarm.py](https://github.com/langchain-ai/langgraph-swarm-py/blob/8956b138bbb475b00c98d040176dbb8da667c612/langgraph_swarm/swarm.py)）。
- Custom workflow：用 LangGraph 把确定性逻辑和 agent 混在一起编排（[index.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/index.mdx)）。

**(c) 通信**
- 共享图 state（通常是 `messages` 列表加自定义 key）。
- subagent 默认 isolated，只拿到任务描述；fork 模式会把父的完整历史传进去，代价是 prompt 更大、隔离更弱（[subagents.mdx L615-L622](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/subagents.mdx#L615-L622)）。
- 官方说 subagent 的主要价值"really about context isolation"（[subagents.mdx L322](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/subagents.mdx#L322)）。

**(d) 稳定性手段**
- checkpointer 在每个 super-step 存快照。某节点失败时，同一 super-step 里已成功节点的 pending writes 会保留，resume 时不重算（[checkpointers.mdx L7/L29/L95-L99](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langgraph/checkpointers.mdx#L29)）。
- `interrupt()` 加 `Command(resume=…)` 实现 HITL。
- `recursion_limit` 是步数硬上限：当前默认值是 `10007`，可用环境变量 `LANGGRAPH_DEFAULT_RECURSION_LIMIT` 改（[_config.py L42-L44](https://github.com/langchain-ai/langgraph/blob/292106d22302cbeb27725a61d91848bd0fd19459/libs/langgraph/langgraph/_internal/_config.py#L42-L44)）。超限报 `GRAPH_RECURSION_LIMIT`，官方解释"often due to an infinite loop"（[GRAPH_RECURSION_LIMIT.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langgraph/errors/GRAPH_RECURSION_LIMIT.mdx)）。
- 节点级 `RetryPolicy`。
- swarm 用 `Literal` 约束 `active_agent`。
- supervisor 默认 `parallel_tool_calls=False`，即一次只交给一个 worker（[supervisor.py L222](https://github.com/langchain-ai/langgraph-supervisor-py/blob/88859b34017ac3569bbd4a3092c7e77593a0a960/langgraph_supervisor/supervisor.py#L222)）。

**(e) 已知失败模式与限制**
- 什么时候不该用：官方原话"not every complex task requires this approach—a single agent with the right (sometimes dynamic) tools and prompt can often achieve similar results"（[index.mdx L6](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/index.mdx#L6)）。
- 官方给了调用次数对比（[index.mdx](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/index.mdx)）：
  - 单次请求时，subagents 比 handoffs、skills 多 1 次调用。
  - 重复请求时，handoffs、skills 这类有状态模式省 40-50% 的调用。
  - 多领域请求时，handoffs 要 7 次以上调用、约 14K token，subagents 是 5 次、约 9K token。
- handoff 必须补一条配对 `tool_call_id` 的 `ToolMessage`，否则"conversation history becomes malformed"（[handoffs.mdx L99](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/handoffs.mdx#L99)）。
- subgraph handoff 的上下文处理稍有不慎，就会"malformed conversation history or bloated context"（[handoffs.mdx L341](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langchain/multi-agent/handoffs.mdx#L341)）。
- interrupt 恢复时节点从头重跑，interrupt 之前的副作用会再执行一次，必须幂等（[interrupts.mdx L1023](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/langgraph/interrupts.mdx#L1023)）。另外两条规则：不要在一个节点里写 `while True`+`interrupt`（L927）；不要用裸 try/except 包 `interrupt`（L1026）。
- 嵌套 supervisor 的迁移规则：只给最外层图配 checkpointer，subagent 不配自己的（[migrate L41](https://github.com/langchain-ai/docs/blob/e4c62bf6591a382abef9bbe96b13b68b2fc5cb3a/src/oss/python/migrate/langgraph-supervisor.mdx#L41)）。

### 小结：稳定性收益来自哪里

**来自声明的结构（预设、工作流）**
- 顺序和并行不交给 LLM 决定：ADK 的模板工作流和 graph，MAF 的 Sequential、Concurrent、Workflow，CrewAI 的 sequential 和 Flows，LangGraph 的 StateGraph。四家都明说可预测性来自这一层（ADK、MAF 文档）。CrewAI 和 LangChain 把"外层 Flow 或图，内层 agent"定为推荐形态。
- 限定谁能交给谁：MAF 的 `add_handoff` 白名单，ADK 的 `disallow_transfer_to_*`，CrewAI 的"只有 manager 委派、specialist 设 `allow_delegation=False`"（官方给的委派循环解法）。
- 构建期校验：MAF 校验类型、连通性、死端；CrewAI 拒绝带额外工具的 manager；ADK 和 swarm 用 enum 或 Literal 把目标名限定在已声明的成员里。
- 一个反向信号：两家都在把"LLM 自己组队"的高层封装降级。LangChain 不再积极维护 `langgraph-supervisor`，改推"subagent 即工具"；ADK 把模板工作流标为 deprecated，改推 graph。MAF 对 Magentic 的原话是"outside the original design … untested"。**推断**：业界在收敛到"声明骨架加受限的 LLM 节点"，而不是"预设一个自由协作的团队"。

**来自运行时机制**
- 预算和硬上限：ADK `max_llm_calls=500`，MAF 100 个 superstep、`max_round`、`max_reset`，AutoGen 的 `max_turns` 和终止条件组件，CrewAI 的 `max_iter`、`max_execution_time`、`max_rpm`，LangGraph 的 `recursion_limit`。
- 停滞检测和重规划：Magentic 的 progress ledger 加 stall counter，超过 `max_stall` 就 reset 并 replan。这是本次四家里唯一的运行时"自愈"机制。
- 结构化输出加解析重试和回退：MAF 的 ledger JSON 重试 3 次，AutoGen 重试 10 次，AutoGen Selector 带反馈重问后回退到上一位，ADK 的 `output_schema`，CrewAI 的 guardrail 重试 3 次。
- 超步 checkpoint、pending writes、resume：MAF 和 LangGraph 都在 superstep 边界存档，CrewAI 用 `@persist`/`checkpoint`。前提是 ID 稳定、副作用幂等。
- HITL 闸门：plan review、approval-required 工具、`interrupt`、`@human_feedback`。
- 上下文隔离：ADK 的 task 分支，LangChain 默认 isolated 的 subagent，MAF handoff 过滤工具内容。用来防止 context bloat。

## C. 产品平台：Agent Team / 子 Agent 编排调研（截至 2026-11-19）

说明：源码链接固定到 commit。dify `76e72ed`（2026-11-19），其图引擎 graphon 按 dify 的 pin 取 `4fa2214`；coze-studio `fefb05f`（2026-07-29）；OpenManus `3309bf4`（2026-08-16）。cursor.com 的页面直接抓取一直失败（socket closed / TLS）。其中 `/docs/subagents` 用的是用户贴来的页面原文，其余 Cursor 页面（changelog、Agents Window、Cloud Agents API）只能用搜索引擎索引里的摘录。没有出处的结论标 **推断**。

### Dify

- **(a) 原语与数据形状**
  - 编排单位是 Workflow（单次执行）和 Chatflow（多轮对话，多出会话变量和记忆）。Workflow 变量只在一次执行内存在，会话变量只在 Chatflow 里有，跨轮保留（[Key Concepts](https://docs.dify.ai/en/learn/key-concepts)，[Variable Assigner](https://docs.dify.ai/en/cloud/use-dify/nodes/variable-assigner)）。
  - 每个节点都有公共字段 `error_strategy`（`fail-branch` | `default-value` | 空）、`default_value[]`，以及 `retry_config{max_retries, retry_interval(ms), retry_enabled}`（[graphon base_node_data.py L17-L22, L133-L151](https://github.com/langgenius/graphon/blob/4fa22141774dff80e90e4dfa98ea3e6fbf0421bb/src/graphon/entities/base_node_data.py#L17-L151)，[enums.py L93-L101](https://github.com/langgenius/graphon/blob/4fa22141774dff80e90e4dfa98ea3e6fbf0421bb/src/graphon/enums.py#L93-L101)，[dify 对 graphon 的 pin](https://github.com/langgenius/dify/blob/76e72ed09862535b95baf3cc196fa29dd2f41071/api/pyproject.toml#L83)）。
  - 经典 Agent 节点的字段：策略（Function Calling / ReAct，Marketplace 里还能装别的）、模型、tools、instruction、query、`Max Iterations`、memory（TokenBufferMemory）（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。
  - 新 Agent（beta，v2 节点）是可单独发布的"预设 Agent"，由角色、prompt、模型、skills、tools、files 组成，跑在自己的沙箱里，并且有版本（[New Agent overview](https://docs.dify.ai/en/cloud/use-dify/build/new-agent/overview)）。在 workflow 里，节点要么"Invite an Agent"引用已发布的 Agent，只写本步任务；要么就地建一个只属于这个节点的 Agent（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。节点数据是 `agent_task: str` 加 `agent_output_routes`（[agent_v2/entities.py](https://github.com/langgenius/dify/blob/76e72ed09862535b95baf3cc196fa29dd2f41071/api/core/workflow/nodes/agent_v2/entities.py)）。`WorkflowOutputRoutes{enabled, routes[{id, name, label}]}` 启用时至少要两条路由，id 唯一且不能用系统句柄 `fail-branch`，`name` 是给模型看的选择条件（[agent_config_entities.py L1129-L1164](https://github.com/langgenius/dify/blob/76e72ed09862535b95baf3cc196fa29dd2f41071/api/models/agent_config_entities.py#L1129-L1164)）。
  - "多 Agent"没有专门的原语，靠图来搭：Question Classifier 把每个类别做成一条出边，类别的描述就是 LLM 读的路由条件（[Question Classifier](https://docs.dify.ai/en/cloud/use-dify/nodes/question-classifier)）。Iteration 对数组逐项跑子图（[Iteration](https://docs.dify.ai/en/guides/workflow/node/iteration)），Loop 带跨轮的 loop 变量（[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)）。
- **(b) 谁决定流程**：图是声明好的，LLM 只在声明好的分叉点里挑一个出口。Classifier 选类别；新 Agent 的 Output Routes 让 Agent "always picks exactly one route"（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。Agent 节点内部的推理循环由 LLM 驱动。
- **(c) 通信**：靠变量池，上游输出用 `/` 或 Jinja2 引用（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。新 Agent 之间不共享沙箱，"两个节点引用同一 Agent 也各自从保存的配置起一个沙箱"，结果只能通过声明的输出传。变量进 Agent 时截断到 2,000 字符，更长的内容要走文件（每个文件 50 MB 上限）（同上）。
- **(d) 稳定性手段**
  - 节点级重试。HTTP/Code 节点最多重试 10 次，间隔上限 5000 ms（[HTTP Request](https://docs.dify.ai/en/guides/workflow/node/http-request)）。
  - 失败策略三选一：None 直接停，Default Value（必须和输出类型一致），Fail Branch。后两种会向下游暴露 `error_type` / `error_message`（[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)）。
  - Iteration 有三种错误模式：`terminated`、`continue-on-error`（失败项输出 null）、`remove-abnormal-output`。并行模式最多 10 项同时跑（[Iteration](https://docs.dify.ai/en/guides/workflow/node/iteration)，[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)）。
  - Loop 有三个终止手段：终止条件、Maximum Loop Count、Exit Loop 节点（[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)）。
  - 全局预算：`WORKFLOW_MAX_EXECUTION_STEPS=500`、`WORKFLOW_MAX_EXECUTION_TIME=3600s`、`WORKFLOW_CALL_MAX_DEPTH=5`、并行线程池 `MAX_SUBMIT_COUNT=100`（[configs/feature L1009-L1053](https://github.com/langgenius/dify/blob/76e72ed09862535b95baf3cc196fa29dd2f41071/api/configs/feature/__init__.py#L1009-L1053)）。这些预算由 `ExecutionLimitsLayer` 执行，它按节点启动事件计步，超限就发 AbortCommand（[execution_limits.py](https://github.com/langgenius/graphon/blob/4fa22141774dff80e90e4dfa98ea3e6fbf0421bb/src/graphon/engine/layer/builtin/execution_limits.py)）。
  - 经典 Agent 的 Max Iterations 文档写明是为了"prevent infinite loops"，建议简单任务 3-5 次、复杂任务 10-15 次（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。
  - 路由输出是结构化的：只能是声明过的 route id，否则节点失败（同上）。
- **(e) 已知失败模式与限制**
  - 模型答不出路由，或给出不存在的路由时，节点失败，需要接 Fail Branch 兜底（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。
  - Loop 里任一子节点失败，整个 loop 立即停（[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)）。
  - 内置错误处理只覆盖 LLM/HTTP/Code/Tool 四类节点（同上）。
  - 新 Agent 仍是 beta，只能用在 Workflow 应用里（[Agent node](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)）。
  - 2,000 字符截断会悄悄丢上下文（**推断**，依据上面的截断规则）。

### Coze / 扣子（coze.cn、coze-studio）

- **(a) 原语与数据形状**
  - 多 Agent 模式由一张节点画布组成：开始节点、Agent 节点（名称、适用场景、Agent 提示词、技能〔工具/工作流/知识库〕、问题建议、模型设置）、智能体节点（引用已发布的单 Agent 智能体，不能改提示词）（[多 Agent 模式](https://docs.coze.cn/guides_multiagent)）。
  - 新的"AI 团队"在项目空间里放人和 Agent。Agent 字段是名称（建议带岗位前缀）、描述、部署设备，可以接 Claude Code / Codex CLI / OpenClaw 这类本地 Agent，派活靠 @（[打造你的 AI 团队](https://docs.coze.cn/cozespace_coze_ai_team_quickstart)）。
  - 开源的 coze-studio 只有单 Agent 领域代码（`backend/domain/agent/singleagent`），源码树里没有 multi-agent 目录（**推断**，依据对 [coze-studio@fefb05f](https://github.com/coze-dev/coze-studio/tree/fefb05ff27be1da939612fbf9faf5db62583b8ae/backend/domain/agent) 文件树的 grep）。
  - 工作流节点的公共错误配置是 `SettingOnError{switch, processType(1 抛出|2 返回 dataOnErr|3 异常分支), retryTimes, timeoutMs, dataOnErr, ext.backupLLMParam}`（[canvas.go L590-L619](https://github.com/coze-dev/coze-studio/blob/fefb05ff27be1da939612fbf9faf5db62583b8ae/backend/domain/workflow/entity/vo/canvas.go#L590-L619)）。Loop 节点有 `loopType` 三种（array/count/infinite），Batch 节点有 `batchSize` / `concurrentSize`，IntentDetector 有 `intents[]`（[canvas.go L282-L289, L440, L658-L663](https://github.com/coze-dev/coze-studio/blob/fefb05ff27be1da939612fbf9faf5db62583b8ae/backend/domain/workflow/entity/vo/canvas.go#L658-L663)）。
- **(b) 谁决定流程**
  - 多 Agent 模式由 LLM 决定：父节点读子节点的"适用场景"，自己判断要不要移交。文档原话是"大型语言模型依赖名称和描述来分配任务"（[多 Agent 模式](https://docs.coze.cn/guides_multiagent)）。
  - 可以声明"全局跳转条件"，命中即跳，优先级高于适用场景，最多 5 个（同上）。
  - 新消息进哪个节点有两种设置："上一次回复用户的节点"（适合多轮连贯任务）或"开始节点"（每条消息重新分派）（同上）。
  - AI 团队里由人 @ 派活，"人负责判断和决策，Agent 负责执行和产出"（[AI 团队](https://docs.coze.cn/cozespace_coze_ai_team_quickstart)）。
  - Workflow 本身是声明好的图。
- **(c) 通信**：多 Agent 模式里各 Agent 在同一个对话中轮流接手，共享对话历史（**推断**，文档没写上下文传递细节）。AI 团队按项目共享对话、文件和资产空间，文档说成员"共享上下文、同步进度"（[AI 团队](https://docs.coze.cn/cozespace_coze_ai_team_quickstart)）。
- **(d) 稳定性手段**
  - 工作流节点：重试次数，超时（所有重试共用同一个超时预算），默认输出，异常分支，重试时 LLM 节点切到备用模型（[canvas.go L598-L619](https://github.com/coze-dev/coze-studio/blob/fefb05ff27be1da939612fbf9faf5db62583b8ae/backend/domain/workflow/entity/vo/canvas.go#L598-L619)）。
  - 多 Agent 模式靠声明的全局跳转条件盖过 LLM 判断，并建议用清晰的 Agent 名称（[多 Agent 模式](https://docs.coze.cn/guides_multiagent)）。
  - 开源版有画布校验，会拒绝嵌套 loop/batch 和图里出现环（`examples/validate/workflow_has_loop.json`、`workflow_nested_has_loop_or_batch.json`，**推断**自[源码树](https://github.com/coze-dev/coze-studio/tree/fefb05ff27be1da939612fbf9faf5db62583b8ae/backend/domain/workflow/internal/canvas/examples/validate)里的文件名）。
- **(e) 已知失败模式与限制**
  - 当前官方文档没有写"回退策略"，也没有写"节点切换模式"（[多 Agent 模式](https://docs.coze.cn/guides_multiagent)）。
  - 单/多 Agent 来回切换会丢失快捷指令和各 Agent 的技能；含智能体节点的智能体不能公开配置（同上）。
  - 二手资料（2024-07，可能已过时）称跳转有三种模式，其中"用对话模型自己判断"常因分心不跳；独立跳转模型不透明，Debug 日志里看不到；跳转"依然不可靠"（[53AI 解析](https://temp53ai.uweb.net.cn/news/coze/2024071705483.html)，非一手）。

### Manus / OpenManus

- **(a) 原语与数据形状**
  - Manus 主体是单 Agent 循环，靠 context engineering 稳住。工具做状态机掩码（logits masking），工具名带分组前缀 `browser_` / `shell_`，每一步只放开某一组（[Context Engineering, 2025-07-18](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。
  - Wide Research 是 Manus 的并行原语：主控制器把请求拆成 n 个独立子任务，每个子任务配一个"full-featured Manus instance"，有完整 VM、全部工具和"a fresh, empty context window"（[Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)）。官方明确说子 Agent 不是预设角色，而是通用 Manus，以此区别于"manager / coder / designer"式的多 Agent（[Introducing Wide Research](https://manus.im/blog/introducing-wide-research)）。
  - OpenManus 的数据形状如下。
    - `BaseFlow{agents: Dict[str, BaseAgent], primary_agent_key, tools}`（[flow/base.py](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/base.py)）。
    - `PlanningFlow{planning_tool, executor_keys[], active_plan_id, current_step_index}`，步骤状态 `not_started | in_progress | completed | blocked`（[planning.py L16-L22, L45-L52](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/planning.py#L16-L52)）。
    - `BaseAgent{state, max_steps=10, current_step, duplicate_threshold=2}`；`ToolCallAgent.max_steps=30`；`Manus.max_steps=20, max_observe=10000`（[base.py L35-L43](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/base.py#L35-L43)，[toolcall.py L36-L37](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/toolcall.py#L36-L37)，[manus.py L50-L51](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/manus.py#L50-L51)）。
- **(b) 谁决定流程**
  - Manus：主控制器用 LLM 拆分并分派，子 Agent 自主执行（[Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)）。
  - OpenManus：LLM 调 planning 工具生成计划，flow 用 Python 顺序遍历步骤。执行者从步骤文本里的 `[TYPE]` 正则 `\[([A-Z_]+)\]` 解析出来，匹配不到就用第一个 executor（[planning.py L77-L92, L245-L247](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/planning.py#L77-L92)）。所以是"LLM 写计划，代码按序执行"。
- **(c) 通信**
  - Manus 把文件系统当作"the ultimate context"，可恢复的压缩只保留 URL 或文件路径（[Context Engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。Wide Research 的子 Agent 之间"do not communicate with each other, all coordination flows through the main controller"（[Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)）。
  - OpenManus：每一步把"CURRENT PLAN STATUS"全文和本步任务拼进 prompt 交给执行者，执行者返回文本摘要（[planning.py L277-L304](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/planning.py#L277-L304)）。
- **(d) 稳定性手段**
  - Manus：
    - 把 KV-cache 命中率当成核心指标：前缀稳定，上下文只追加，序列化确定。
    - 工具不增删，只做掩码（mask, don't remove）。
    - 用 todo.md 复述目标，对抗约 50 步任务里的 lost-in-the-middle。
    - 错误留在上下文里不删。
    - few-shot 加受控扰动，避免模式模仿（[Context Engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。
    - Wide Research 靠隔离：单个子 Agent 的错误或幻觉"does not propagate to the others"（[Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)）。
  - OpenManus：
    - `max_steps` 硬上限。
    - 卡死检测：最近 assistant 内容和历史上的重复次数 ≥ 2，就在 next_step_prompt 前插"Observed duplicate responses. Consider new strategies…"（[base.py L135-L185](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/base.py#L135-L185)）。
    - 观察结果截断到 `max_observe`（[toolcall.py L148-L149](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/toolcall.py#L148-L149)）。
    - 整个 flow 外层套 `asyncio.wait_for(timeout=3600)`（[run_flow.py L32-L42](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/run_flow.py#L32-L42)）。
- **(e) 已知失败模式与限制**
  - Manus 文档：Wide Research 不适合强顺序依赖的任务，也不适合少于 10 项的任务；测试到 250 项（[Wide Research docs](https://manus.im/docs/features/wide-research)）。官方没有公开部分失败、重试和子 Agent 失败上报的机制（同上，[Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)）。批量相似任务会因上下文太一致而漂移（[Context Engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。
  - OpenManus 从源码可见四个问题（均为**推断**）：
    - 执行者跑满 `max_steps` 返回"Terminated"也不抛异常，这一步照样被标成 completed（[planning.py L294-L304](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/planning.py#L294-L304)，[base.py L149-L152](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/base.py#L149-L152)）。
    - 规划 prompt 让模型写 `'[agent_name]'`（[L159](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/flow/planning.py#L159)），解析正则却只认大写，小写名字会静默回落到默认执行者。
    - 卡死检测只认字面完全相同的内容。
    - flow 层是 `while True`，没有步数上限，只靠外层超时兜底。

### Cursor（产品）与 pstack（skill 驱动编排）

- **(a) 原语与数据形状**
  - Cursor subagent 是一个带 YAML frontmatter 的 markdown 文件，放在 `.cursor/agents/` 或 `~/.cursor/agents/`。Cursor 也读 `.claude/agents/` 和 `.codex/agents/`，重名时 `.cursor/` 优先（[cursor.com/docs/subagents](https://cursor.com/docs/subagents)，用户贴来的页面原文，下同）。
    - frontmatter 字段及默认值：`name`（默认取文件名）、`description`（"Agent reads this to decide delegation"）、`model`（默认 `inherit`，也可写具体 id，可带参数如 `claude-opus-5[effort=high,context=300k]`）、`readonly`（默认 false；为 true 时不能改文件，也不能跑改变状态的 shell 命令）、`is_background`（默认 false）。
    - 内置两个 subagent：Explore 和 Browser。官方给的理由是这两类操作的中间输出又多又吵，放在主上下文里会把它撑爆。
  - Cursor 3 有 `/best-of-n`（同一任务跨多个模型、各自一个 worktree 并行，再比较结果）和 worktree 隔离（`/apply-worktree` 合回）（[Cursor 3 changelog](https://cursor.com/changelog/3-0)，[Agents Window](https://cursor.com/docs/agent/agents-window)）。
  - Cloud Agents API 的 `POST /v1/agents` 创建一个持久 agent 并入队第一次 run，后续用"Create A Run"追加（[Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)）。SDK 推荐用云端 runtime 跑大量并行 Agent（[Python SDK](https://cursor.com/docs/sdk/python)）。
  - pstack 的原语是纯文字 skill。
    - swarm：先写 done predicate，再选形状（切片 / 竞速 / 混合），竞速规则 `first pass | rank all | best-of` 要在派发前声明，每个 worker 有自己的可写输出（[swarm/SKILL.md L22-L25](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/swarm/SKILL.md)）。
    - arena：6 个阶段 Frame → Fan out → Cross-judge → Pick → Graft → Verify，含 3-6 条 rubric（[arena/SKILL.md L11-L20](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/arena/SKILL.md)）。
    - interrogate：一组对抗者（[interrogate/SKILL.md](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/interrogate/SKILL.md)）。
    - 角色到模型的映射是一张"角色 → 模型 + effort"的表，写在 `~/.claude/rules/pstack-models.md`（例如 `swarm workers: opus high`、`arena runners: fable high, opus high, inherit-parent`）（[poteto-mode SKILL.md L90-L98](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/poteto-mode/SKILL.md)，[claude-code.md Models](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/docs/harness/claude-code.md)）。
- **(b) 谁决定流程**
  - Cursor：默认由父 Agent 的 LLM 决定委派，依据是任务复杂度、subagent 的 description 和当前上下文；description 里写"use proactively"可以提高被自动调用的概率。用户也可以用 `/name` 显式点名（[subagents](https://cursor.com/docs/subagents)）。
    - 官方给出的 orchestrator 模式是 Planner → Implementer → Verifier 依次执行，"Each handoff includes structured output"，但这只是 prompt 层面的约定，没有运行时强制（同上；"没有运行时强制"是**推断**）。
    - 嵌套：从 Cursor 2.5 起，主 Agent 和它的直接子 Agent 可以再派子 Agent；孙辈不能再派。hooks 或工具策略可以禁止派生（同上）。
  - pstack：阶段顺序、扇出形状、角色模型、评判规则都写死在 skill 文本里。主 Agent 照着执行，只负责切片内容和综合（**推断**，依据上述 SKILL.md 的结构）。也就是把声明好的工作流写成 prose，由 LLM 执行。
- **(c) 通信**
  - Cursor 的上下文：子 Agent 从干净的上下文起步，看不到对话历史，需要的信息全靠父 Agent 写进 prompt；子 Agent 只回传一条最终消息（[subagents](https://cursor.com/docs/subagents)）。
  - 执行方式：前台运行时父 Agent 阻塞等待；后台运行时立即返回，状态写到 `~/.cursor/subagents/`，父 Agent 自己去读。每次执行返回一个 agent ID，凭 ID 可以带着完整上下文续跑（同上）。
  - 并行与隔离：父 Agent 在同一条消息里发多个 Task 就会并行。默认所有子 Agent 共用父 Agent 的 checkout；要求隔离时，每个子 Agent 拿到自己的 worktree 或云 VM，以及独立分支，改动由父 Agent 负责合并（同上）。
  - 云端子 Agent：`/in-cloud`、`/autopilot` 启动，MCP 用团队在云端的配置（同上）。
  - pstack：brief 必须自足，传文件路径而不是内联上下文；产物写进各自的 worktree 或目录；结果格式固定为 `PASS | ISSUES | BLOCKED` 加证据（[swarm L33](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/swarm/SKILL.md)，[poteto-mode L90](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/poteto-mode/SKILL.md)）。
- **(d) 稳定性手段（Cursor）**
  - 嵌套深度硬性限制为 2 层；隔离靠 worktree 或 VM 加独立分支，改动由父 Agent 合并（[subagents](https://cursor.com/docs/subagents)）。
  - 子 Agent 失败时向父 Agent 返回 error status，父 Agent 自己决定重试、补上下文续跑，还是换别的处理方式；平台没有内置的重试策略（同上）。
  - 官方推荐加一个 verifier subagent，用来解决"AI marks tasks as done but implementations are incomplete or broken"；需要结构化产出文件时，建议用 hooks 落盘（同上）。
  - 配置的模型被管理员禁用或套餐不支持时，自动回退到兼容模型（同上）。
- **(d) 稳定性手段（pstack 写明的门禁）**
  - 结果没记录 brief 要求的 SHA 和方法就作废，重派一次；第二次再缺就记为 gap，gap 不算通过（[swarm L39](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/swarm/SKILL.md)）。
  - cross-judge 必须和父 Agent 不是同一厂商，按 rubric 逐条打分。候选结果分歧太大时重新 Frame，不取平均（[arena L30-L42](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/arena/SKILL.md)）。
  - interrogate 只保留"用一次真实运行证明了"的发现，由主 Agent 重跑命令复核（[interrogate L21-L25](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/interrogate/SKILL.md)）。
  - figure-it-out 要求先建验证 harness 并记录基线；判定只有 VERIFIED / NOT VERIFIED / INCONCLUSIVE 三种，INCONCLUSIVE 不算过；worker 钻门禁的空子就重置并收紧契约（[figure-it-out L31-L44](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/figure-it-out/SKILL.md)）。
  - 验证固定用 `swarm workers` 模型；返工交给一个新 subagent，不续用旧的（[poteto-mode L98-L102](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/poteto-mode/SKILL.md)）。
- **(e) 已知失败模式与限制**
  - Cursor 官方文档自己点出的问题（[subagents](https://cursor.com/docs/subagents)）：
    - 不隔离时，多个子 Agent 同时改文件会互相覆盖。
    - 5 个并行子 Agent 大约消耗 5 倍 token；每个子 Agent 都要重新收集上下文，简单任务反而比主 Agent 慢。
    - 不要建几十个泛泛的 subagent，建议从 2-3 个专职的开始；description 写得含糊，Agent 就不知道该什么时候委派。
    - 旧的按请求计费套餐如果没开 Max Mode，subagent 一律用 Composer 跑，`model` 字段被忽略。
  - Cursor 社区报告 Cursor 3 改版后 worktree 和 best-of-n 一度失效，官方人员说"no ETA"（[forum](https://forum.cursor.com/t/cursor-3-worktrees-best-of-n/156507)，非一手文档）。
  - pstack 的门禁全靠主 Agent 自觉执行，没有运行时强制；模型被拒时按规则降级，执行时要说明（[arena L19](file:///home/zibyn/.claude/plugins/cache/cursor-plugins/pstack/0.15.43/skills/arena/SKILL.md)）。"prose 契约无法强制"这一点是**推断**。

### Devin（Cognition）

- **(a) 原语与数据形状**
  - Managed Devins：协调者 session 起子 session，每个子 session 带自己的 prompt、skill、tags 和 ACU limit，运行在各自的 VM 里（[Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)，[Manage Devins, 2026-03-19](https://cognition.com/blog/devin-can-now-manage-devins)）。
  - Dynamic Workflows 是 Python 脚本，原语有 `register_workflow(meta)`、`agent(prompt, phase, schema)`（返回按 JSON Schema 成形的 dict）、`pipeline(items, *stages)`、`parallel([...])`、`log()`。保存成 `workflow.py` 放在 `SKILL.md` 旁边就能复用（[Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)）。
- **(b) 谁决定流程**：两种模式并存。Managed Devins 由协调者 LLM 拆分、监控、解冲突、汇总。宽扇出加合并、或后一阶段依赖前一阶段输出的场景，官方建议改用 dynamic workflow，"so the coordination runs as a recorded, resumable script"，即由 LLM 写出声明式脚本后确定性执行（[Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)）。
- **(c) 通信**
  - 协调者可以给运行中的子 session 发消息；子 session 完成或需要输入时唤醒协调者，不用轮询；MCP 提供一次调用等全部完成（[Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)）。
  - workflow 里阶段之间传 JSON 结构化输出；代码通过 git 分支流转，子 Agent 在输出里报告分支名（[Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)）。
  - Cognition 主张共享尽可能多的上下文，包括相同来源、plan/todo 文件和共同先验（[Multi-Agents: What's Actually Working, 2026-04-22](https://cognition.com/blog/multi-agents-working)）。
- **(d) 稳定性手段**
  - 录制与重放：每次 `agent()` 调用以 prompt、schema 和执行设置的哈希为键记录；resume 时已完成的调用直接重放，未完成的用新 session 重跑；改了某个 prompt，只重跑它和它的下游。
  - 确定性规则：脚本逻辑不得依赖时间、随机数、环境变量、文件系统或网络。
  - 子 Agent session 死掉或没给出合法结构化输出时，由脚本决定跳过、用默认值、重试还是失败。
  - 一次 run 预算默认也最多 7 天；可以关掉 auto-approve 改成逐次审批（[Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)）。
  - 子 session 有 ACU 上限，协调者可以让跑偏的子 session 休眠或终止（[Advanced Capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)）。
  - 写操作保持单线程，用 generator-verifier 结构：Devin Review 平均每个 PR 抓 2 个 bug，约 58% 是严重 bug；reviewer 只看 diff，用干净上下文（[What's Actually Working](https://cognition.com/blog/multi-agents-working)）。
- **(e) 已知失败模式与限制**
  - "Don't Build Multi-Agents"提出两条原则："Share context, and share full agent traces, not just individual messages"，以及"Actions carry implicit decisions, and conflicting decisions carry bad results"。Flappy Bird 例子里两个子 Agent 各自误解了任务，风格互相冲突（[Don't Build Multi-Agents, 2025-06-12](https://cognition.com/blog/dont-build-multi-agents)）。
  - 2026-04 的更新文章说并行写的 swarm 仍然很少被采用，能用的是"writes stay single-threaded"的那一类，推荐 "map-reduce-and-manage"（[What's Actually Working](https://cognition.com/blog/multi-agents-working)）。
  - 同一篇文章列出 manager 的失败模式：缺代码库上下文时指令过细；以为和子 Agent 共享了其实不存在的状态；子 Agent 默认不向 manager 回报（同上）。
  - 成本：workflow 里每个 Agent 都是一个完整 session，ACU 消耗可能高得多（[Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)）。shared-VM 模式下并行写入必须严格不重叠文件（同上）。

### Kimi（Moonshot K2.5 Agent Swarm / PARL）

- **(a) 原语与数据形状**：编排者在搜索、代码和浏览工具之外多出两个工具，`create_subagent{name, system_prompt}`（"for reuse across tasks"）和 `assign_task`。子 Agent 是"dynamically instantiated rather than pre-defined"，各有自己有界的本地上下文（[K2.5 技术报告 §3、附录 E.8](https://arxiv.org/html/2602.02276)）。
- **(b) 谁决定流程**：完全由模型决定。团队组成也由编排者在运行时现建，并通过 RL 训练出来（同上）。
- **(c) 通信**：子 Agent 的输出作为环境观察回到编排者，文中称之为"context sharding rather than context truncation"（同上）。
- **(d) 稳定性手段**
  - 训练时冻结子 Agent，只训练编排者，以避开信用分配和训练不稳。
  - 奖励 r = λ1·r_parallel + λ2·r_finish + r_perf：r_parallel 防"serial collapse"，r_finish 防"spurious parallelism"（狂开子 Agent 刷并行指标），λ 逐步退火到 0。
  - 用 CriticalSteps（类似关键路径）衡量代价。
  - 步数预算举例：BrowseComp 编排者 15 步、子 Agent 100 步（同上）。
- **(e) 已知失败模式与限制**：报告把 serial collapse 和 spurious parallelism 作为需要奖励项压住的失败模式（同上）。WideSearch 上延迟最多降 4.5 倍，Item-F1 从 72.7 提到 79.0（同上）。报告正文没有单独的局限性章节（同上）。

### MiniMax Agent（Mavis / Agent Team）

- **(a) 原语与数据形状**：角色是 Leader / Worker / Verifier；编码场景是 Leader / Developer / Tester / Reviewer。"One lifecycle is one Session, and the state machine is the Team Engine"，任务状态为 producing → verifying → done。Developer 的 brief 包含需求、相关文件、约束和禁止动作，交回改动理由、风险和验证建议（[Agent Team, 2026-05-27](https://www.minimax.io/blog/minimax-agent-team-long-running-1779893953)）。没有公开 schema（同上）。
- **(b) 谁决定流程**：Leader（LLM）决定拆分粒度、重试次数和何时升级给人。状态转移由 Team Engine 的确定性代码驱动，"When verifying fails, the Team Engine wakes up the producing node again"。合并代码、覆盖生产数据这类高风险动作要人签字（同上）。
- **(c) 通信**：三条通道。Agent 内记忆（注入后续运行，也推给正在运行的 Agent）、Agent 间 CLI 发中断式消息、whiteboard 存较大的持久内容按需拉取。另有共享 notepad 文件和交接文件。`prompt / spawn / abort / kill` 统一成一个操作接口，调用方可以是用户、Agent 或 Engine（同上）。
- **(d) 稳定性手段**："deterministic code logic"驱动的循环加"adversarial quality gates"。Worker 和 Verifier 是对抗关系；编码场景把 test / lint / build / format 当作一等门禁；搜索缓存只算线索，不算证据；每一步上下文隔离（同上）。
- **(e) 已知失败模式与限制**：文章点名的失败模式有：Agent 提前停下来请用户继续（"context anxiety"）；长任务漂移，下游沿着偏差继续生成；edit-reject 循环空转；验证"just goes through the motions"；10 合 1 的汇总难。文章引用外部研究说同质辩论的 token 成本是单 Agent 自纠的 2.1-3.4 倍（同上）。没有给出自家的预算数值和基准（同上）。

### 小结：稳定性收益来自声明结构，还是来自运行时机制

**来自声明结构（预设、工作流、契约）**

- 有限出口加结构化选择：Dify Output Routes 和 Classifier 只能选声明过的出口，选错就走 Fail Branch；Coze 全局跳转条件盖过 LLM 判断；Devin workflow 用 JSON Schema 约束阶段输出。
- 固定拓扑和阶段：Devin 的 `pipeline` / `parallel` 脚本；pstack 的 Frame → Fan out → Judge → Verify；MiniMax 的 producing → verifying → done；OpenManus 让代码按计划顺序执行。
- 预设角色加验证者：MiniMax 的 Verifier 和 Reviewer、Devin Review、pstack 的跨厂商 judge 和 interrogate。收益来自"必须过门禁"，不是来自角色名字本身（**推断**）。Manus 和 Kimi 则明确选择不预设角色，或在运行时现建角色。
- 节点级失败策略是声明出来的：Dify 和 Coze 的 retry、超时、默认值、异常分支，Iteration 的错误模式。
- 结果契约：pstack 的 `PASS/ISSUES/BLOCKED` 加 SHA，缺了就重派一次再记 gap；Dify 新 Agent 声明的输出。

**来自运行时机制**

- 预算和熔断：Dify 的 500 步 / 3600 s / 嵌套深度 5 加 AbortCommand；OpenManus 的 max_steps、卡死检测和 3600 s 超时；Devin 的 ACU 上限和 7 天上限；Kimi 的每角色步数上限。
- 录制、重放、可恢复：Devin workflow 用哈希键重放，加确定性规则。
- 隔离：每个子 Agent 一个新上下文、一个独立 VM 或沙箱、一份 worktree（Manus Wide Research、Devin、Dify 新 Agent、Cursor、pstack）。避免并行写冲突（Cognition 主张单线程写）。
- 上下文工程：Manus 的 KV-cache 稳定、工具掩码、todo.md 复述、保留错误、文件系统当记忆。
- 事件唤醒和控制面：Devin 子 session 完成即唤醒协调者；MiniMax Engine 在验证失败时重新唤醒生产者，并统一了 spawn/abort/kill 接口。
- 训练：Kimi PARL 用奖励项压住 serial collapse 和 spurious parallelism，这是模型侧的稳定性，平台侧无法复制（**推断**）。
