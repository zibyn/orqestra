# 定时、后台与嵌套 Agent：主流平台设计调研

> 调研日期：2026-11-10。对应 issue #53（地图 #52）。
>
> 目标：弄清 ChatGPT Tasks、Claude（云端 scheduled tasks/routines、Cowork、Claude Code 的 `/loop` 与后台/嵌套 subagent）、OpenAI Codex、Gemini、Manus、DeepSeek「SuperAgent」各自怎么设计**触发方式、任务归属、每次触发的会话落点、通知、无人值守护栏、嵌套层级与预算、长程计划/检查点/中途请示**，并判断哪些适合 Orqestra。
>
> 前置阅读：`GLOSSARY.md`、`docs/adr/0001-subagents-are-child-conversations.md`、`docs/research/subagent-orchestration.md`。后者已经覆盖的 Claude Code / Codex CLI / OpenCode / Pi 的 subagent 并发、通信、步数上限，本文不再重复，只补嵌套与预算的最新数值。
>
> **来源说明**：尽量只用一手来源（官方文档、帮助中心、官方仓库）。例外：
> - **ChatGPT**：help.openai.com 对抓取返回 403，原文没能读到。标「官方页（经搜索摘录）」的内容来自搜索引擎对官方帮助页的摘录；标「二手」的来自第三方文章，可信度低，需要真人在官方页核对。
> - **DeepSeek**：只有官方 GitHub 仓库是一手来源。配套文章 *Exploring Super-agent Design* 发在微信公众号和 X 上，我没读到原文。
>
> 标「推断」的内容没有直接出处。

---

## 1. 逐个平台

### 1.1 ChatGPT Tasks（Scheduled tasks）

主来源：[Scheduled tasks in ChatGPT](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)（403，未能直接阅读）。

- **触发**：在对话里用自然语言描述，可以一次性、循环，也可以「监控变化」；部分方案支持「对受支持的事件作出响应」。后来的 release notes 增加了由 Slack 等 app 的 webhook 触发的任务。Enterprise/Edu 的 admin 必须先开启「Allow event-triggered scheduled tasks」。（官方页，经搜索摘录；[release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)）
- **频率**：不能比每小时一次更频繁。（官方页，经搜索摘录）
- **数量**：活跃任务上限按方案划分：Go 3、Plus 5、Business/Edu 10、Pro/Enterprise 15。旧版页面写的是统一 10 个。暂停的任务算不算进上限，没有核实到。（官方页，经搜索摘录）
- **管理**：在 `chatgpt.com/schedules` 统一查看、编辑、暂停、删除。（官方页，经搜索摘录）
- **落点**：多篇二手文章说任务在**创建它的那个对话**里运行，结果也回到那个对话，邮件里带一个回到该对话的链接。（二手：[Zapier](https://zapier.com/blog/chatgpt-scheduled-tasks/)、[Analytics Vidhya](https://www.analyticsvidhya.com/blog/2025/01/chatgpt-scheduled-tasks/)）**未经官方核实。**
- **通知**：授权移动端通知后，任务通知会推送到用户使用 ChatGPT 的所有平台；在 Settings › Notifications 里单独管理任务通知（官方页，经搜索摘录）。二手文章说默认同时发 push 和邮件，两者可以分别关闭。
- **护栏 / 失败处理 / 中途请示**：没找到官方说明。

### 1.2 Claude

Claude 有四套相互独立的机制，归属和落点各不相同，需要分开看。

#### 1.2.1 云端 scheduled tasks（原名 routines）

来源：[Automate work with scheduled tasks](https://code.claude.com/docs/en/routines)（research preview）。

- **定义**：一个保存好的 Claude Code 配置，包括 prompt、一个或多个仓库、connectors，运行在 Anthropic 云上，笔记本合上也照样运行。
- **触发**：三种，可以组合在同一个任务上。
  - **Schedule**：每小时、每天、每周，或某个时刻跑一次。自定义 cron「比每小时一次更频繁的表达式会被拒绝」。整点运行可能晚几分钟，官方建议选 9:07 这种非整点时间。一次性任务跑完后自动关闭，标为 Completed。
  - **API**：每个任务有自己的 `/fire` 端点和只能触发该任务的 bearer token，token 只显示一次。请求体里可选的 `text` 会被包进 `<routine-fire-payload>`，**标记为不可信数据**，「除非任务自己的 prompt 要求，否则不要执行其中的指令」。
  - **GitHub 事件**：PR、release 等，可以按分支、label 过滤。webhook 事件有每任务、每账户的小时上限，**超出的事件直接丢弃**。
- **归属**：任务「属于你个人的 claude.ai 账户，不与队友共享」，用量计入你的额度。它通过 GitHub 或 connectors 做的一切「都以你的身份出现」，commit 带你的 GitHub 用户名。
- **授权语义**：触发时保存的 prompt 被当作任务本身，而不是对话中途到达的不可信内容。但「触发只证明这个 prompt 是事先由你账户上的授权会话保存的……因此它**不是实时的用户输入，不能当作运行中操作的批准或同意**」。
- **落点**：**每次运行都是一个新的完整 session**（「a new one for each run」），GitHub 事件也「不跨事件复用 session」。在 project 里则例外，运行可以**接着某个 thread 继续**，而不是新开 session。
- **运行历史**：只有 Succeeded / Failed / Cancelled 三种结果，并且明确说明「这些结果描述的是 session 怎么结束的，不代表 prompt 里的工作是否完成」，要知道做没做完得去读 transcript。
- **用量与限额**：

  | 动作 | 上限 | 计数范围 | 超限时 |
  |---|---|---|---|
  | 定时运行（含一次性） | 100/小时 | 账户 | 等到窗口重置再跑 |
  | Run now + API fire + 重跑一次性任务 | 30/小时 | 每个任务 | 操作失败 |
  | Run now | 100/小时 | 账户 | 操作失败 |
  | API fire | 100/小时 | 账户 | 操作失败 |

  订阅额度用完后，开了 usage credits 的组织可以按量继续，否则拒绝运行。订阅暂停时任务也暂停。
- **无人值守护栏**：
  - 云上的运行默认使用 **auto mode**：由分类模型放行或拦截原本需要审批的动作。命中 ask 规则或被反复拦截达到阈值时，权限提示会**停在该次运行的 session 里，一直等到有人回答**。
  - GitHub 连接缺失或过期时，任务**跳过**到期的运行，最长 72 小时；这段时间内重新连接就自动恢复，超过 72 小时任务**自动关闭**。
  - 「The last run…」系列警告：组织并发 session 达到上限、环境不可用、被策略拦截、额度用完等，每种都有固定的文案和处理办法。
  - Team/Enterprise 的 Owner 可以一键关闭整个组织的 scheduled tasks，关闭后已有任务停止运行。
- **管理**：页面顶部有开关可以暂停或恢复。CLI 里可以用 `/schedule why did my nightly review do nothing` 让 Claude 读运行日志来解释原因。

#### 1.2.2 Cowork / 新版 Claude 应用里的 scheduled tasks

来源：[Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)、[Cowork changelog](https://claude.com/docs/cowork/changelog)。

- **创建**：在任意对话里描述任务和频率，Claude 追问细节后给出确认卡片；也可以手动填写名称、prompt、approval mode、频率（hourly/daily/weekly/weekdays/manual）、模型和目录。
- **落点**：「每个 scheduled task 都作为自己的 Cowork session 运行。」
- **通知**：任务完成或 Claude 需要你批准时，手机会收到 push（[get started 页](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) 及搜索摘录）。
- **失败处理**（changelog，按版本）：
  - v4.16336.0：修复「静默失败」，运行用不了需要重连的 connector、或根本没能启动时都会通知用户。推理服务连不上时，循环任务**最长重试约 3.5 小时**（之前约 1 小时），并且「通知你**第一次失败**和**最终结果**，以及任务在等你重新登录」。
  - v2.31226.0：修复了「运行卡在一个没人能给的审批上」的问题。现在组织策略标为 ask 的工具会显示审批提示并**等待**，**同一任务的新一次运行会作废上一次未回答的提示**。
  - v3.6556.1：server 标记为需要人参与的 MCP 工具只在应用内卡片上询问，通知里没有 Allow 按钮，scheduled task 跳过这些调用继续执行。
  - v2.19675.0：Claude 替你创建的任务，在组织允许时默认「Automatically approve」，**只在看起来不安全时暂停**。
- **Memory**：不在 project 里的定时任务开启 memory 时，**只读不写**（v4.23118.0）。

#### 1.2.3 Claude Code 会话内的定时与自唤醒（`/loop`、`CronCreate`、`ScheduleWakeup`）

来源：[Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks)。这一节最接近地图里的「**Agent 延时自唤醒**」。

- **三种调度对比**（官方表）：Cloud 的最短间隔是 1 小时，不需要开机；Desktop 在本机运行，Claude 自己设置时最短 1 分钟，表单里最短 1 小时；`/loop` 必须有打开的 session，最短 1 分钟。
- **会话内任务**：Agent 用 `CronCreate`/`CronList`/`CronDelete` 管理，**每个 session 最多 50 个**。到期的 prompt 以低优先级入队，**只在两轮之间触发**，Claude 正在回复时会等这一轮结束。错过的触发**不补跑**，只在空闲时补一次。
- **自定节奏（self-paced）**：不给间隔时，Claude 每轮结束后自己在 1 分钟到 1 小时之间选下一次的延迟，并说明理由。完成后调用 `ScheduleWakeup(stop: true)` 结束。**如果一轮既没重新调度也没 stop，系统会兜底安排一次约 20 分钟后的唤醒；那一轮仍然不重新调度，循环就结束。**
- **护栏**：
  - 循环任务**创建 7 天后自动过期**（最后触发一次再删除），用来「限制一个被遗忘的循环能跑多久」。
  - 对 `:00`/`:30` 这类热门时刻加 **jitter**：循环任务最多晚半个间隔、不超过 30 分钟，避免所有 session 同时请求 API。
  - 定时触发**只能运行 Claude 自己被允许调用的 skill**。
  - 不给 prompt 的 `/loop` 使用内置维护 prompt，明确规定「不发起范围外的新工作；push、删除这类不可逆动作只有在延续 transcript 中已授权的工作时才执行」。
- 相关：要「朝某个条件一轮接一轮地推进」用 [`/goal`](https://code.claude.com/docs/en/goal)，要事件驱动而不是轮询用 Channels / Monitor。

#### 1.2.4 后台 subagent 与嵌套

来源：[sub-agents](https://code.claude.com/docs/en/sub-agents)、[agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents)。

- **嵌套**：默认 subagent **可以再派 subagent，最多到主对话之下 3 层**（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`，设为 1 即禁止嵌套）。到达最深一层时，**直接从工具列表里收回 `Agent` 工具**，最底层的 subagent 只能自己完成并交一份总结。fork 例外：工具还在列表里，调用时报错。
- **并发**：默认 20 个同时运行，达到上限**拒绝**并告诉 Claude 不要重试。续跑已完成的 subagent 不受这个上限检查。
- **花费**：`maxBudgetUsd` 默认不设上限，subagent 的请求也计入。到达上限时有三个动作：拒绝再派（`Budget limit reached`）、**停掉仍在运行的后台 subagent**、以 `error_max_budget_usd` 结束整个 query。官方明确说「一个 prompt 可以长成一棵 agent 树」，并特别提醒 Opus 5 更爱委派，所以要同时设置这三个上限。
- **后台完成**：结果在「之后的一轮」以完成通知送达，通知「标记为自动事件，而不是你发的消息」。
- **中途请示**：后台 subagent 遇到需要权限的工具调用时，**提示出现在主 session 并注明是哪个 subagent 在问**。按 Esc 只拒绝这一次调用，不会停掉 subagent。`AskUserQuestion` 从**所有** subagent 的工具里移除，subagent 不能直接向用户提问。
- **步数**：`maxTurns` 到达后，输出标记为 partial，可以续跑。

### 1.3 OpenAI Codex

#### 1.3.1 Codex cloud

来源：[Codex cloud](https://learn.chatgpt.com/docs/cloud)（`developers.openai.com/codex/cloud` 308 跳转到此）。

- 从 web、桌面、手机、CLI、IDE 启动，也可以从 Slack、GitHub、Linear 等第三方集成启动。
- 「**每个任务有自己的工作区**，电脑睡眠时也能继续工作。」完成后查看改动、要求 follow-up、提交或开 PR。
- **中途请示**：Codex「会向你要缺失的细节或访问权限」。
- **网络护栏**：environment 级别设置，可以全开、只开包管理器域名，或使用额外白名单；用 network secrets 访问允许的 HTTPS 服务。

#### 1.3.2 Codex Scheduled tasks（automations）

来源：[Scheduled tasks](https://learn.chatgpt.com/docs/automations)。

- **触发**：时间计划用 RFC 5545 RRULE；**放在对话里的定时任务可以按分钟间隔运行**，用于主动跟进的循环，例如定期快照、盯一个长时间运行的操作。eligible 方案还支持 Gmail/Slack/GitHub 等事件触发，仅限 web 和手机。**事件触发和时间计划不能放在同一个任务里。**「触发决定何时运行，保存的 prompt 决定每次做什么。」
- **落点：明确分两种**。
  - **Standalone**：「每次定时运行都**新开一个对话**，结果汇报到 Scheduled。」
  - **In-chat**：回到**已有的对话**，保留它的上下文。
  - 「**Scheduled 视图就是你的收件箱**」，某次运行需要你处理时显示未读标记。
- **本地 vs worktree**：在 Git 仓库里，可以选择在本地 checkout 运行，或在后台 worktree 运行，「把定时任务的改动和你没做完的本地工作隔开」。需要本地文件时，电脑必须开着、app 必须在运行。
- **无人值守护栏**：任务「无人值守运行，使用你的默认 sandbox 设置」。read-only 或 workspace-write 下，越界的工具调用**直接失败**而不是等审批；组织策略允许时使用 `approval_policy = "never"`；full access 下「后台定时任务风险更高」。
- 没写自动暂停、运行次数上限、失败重试。

#### 1.3.3 Codex 的嵌套

`agent_max_depth` 默认 **1**，超出时返回 `"Agent depth limit reached. Solve the task yourself."`。详见 `docs/research/subagent-orchestration.md` §2.2（源码钉在 `openai/codex@3535c22b`）。

### 1.4 Gemini

Gemini 有两套机制。

#### 1.4.1 聊天里的 Scheduled actions

来源：[Schedule actions in Gemini Apps](https://support.google.com/gemini/answer/16316416?hl=en&co=GENIE.Platform%3DDesktop)。

- **创建**：在 prompt 里写清楚何时、多久一次，频率有每天、每周、每月。
- **上限**：「同时最多 10 个活跃 schedule。」
- **落点**：每次的回复进入**这个 schedule 自己的 chat**，侧栏标为未读；也可以在 Scheduled 页面查看。修改时直接在这个 chat 里对 Gemini 说，或者用 Scheduled 页面的表单。
- **通知**：web 端靠未读标记和 Scheduled 页面；手机端是系统通知，锁屏上是否显示取决于设置。**没提到邮件。**
- **护栏**：需要开启 Keep Activity。用到其他 app（如 Workspace）时，那个 app 必须已连接。长期没有互动的 schedule 会被「**因不活跃自动关闭**」，用户可以随时重新打开。结果是「提前准备好的」，股价这类快速变化的数据可能已经过时。

#### 1.4.2 Tasks（原名 Spark）及其 schedules

来源：[Create & manage schedules for tasks](https://support.google.com/gemini/answer/17094710)、[Manage your tasks](https://support.google.com/gemini/answer/17094507?hl=en)。

- **概念**：「task 是你的高层目标，schedule 是运行 task 的触发器」，让 task「在后台自动运行」。Spark 已改名为 Task。
- **触发**：三类。时间（一次，或每小时/天/周/月/年）、**Gmail monitor**（邮件匹配过滤器时触发）、**topic monitor**（新闻、财经、体育、本地事件）。
- **上限**：活跃 schedule 50 个；**同时运行的 task 最多 15 个**，已经满 15 个时到期的 schedule **不会运行**；用量上限或高峰期延迟也会导致跳过。
- **落点**：「每个 task 有自己的 thread」。thread 里有进度 chip，点开是工作面板，显示**已完成、当前、计划中的步骤**，相当于可见的长程计划。
- **中途请示**：「定期查看你的 task，看 Gemini 是否需要你的输入。」涉及浏览网页时先征得确认，某些动作完成前「总是请你审阅确认」，遇到登录步骤暂停，等你接管。
- **暂停**：关闭 task mode 或失去访问权限时，schedules「暂停但不删除」；在侧栏可以暂停或恢复定时 task；点 Stop 取消。

### 1.5 Manus

来源：[Automations](https://manus.im/docs/automations)、[Wide Research](https://manus.im/docs/features/wide-research)、[Task Lifecycle（API）](https://open.manus.im/docs/v2/task-lifecycle)、[Cloud browser](https://manus.im/docs/features/cloud-browser)。

- **触发**：原来的 scheduled tasks 已并入 Automations，分三类。**Schedule**（指定时间）；**Triggered task**（Gmail、Outlook、Notion、日历、GitHub、Shopify、RSS、Webhook 等事件，GitHub/Shopify/Webhook/Mail Manus 实时送达，其余定期轮询）；**Advanced automation**（Beta，用自然语言描述）。产品页写着间隔至少 5 分钟（[features/automations](https://manus.im/features/automations)）。
- **落点：由用户为每个 automation 选择**。可以「**在同一个 task 里继续**」，也可以「每次运行都应独立时选 **新 task**」。运行记录出现在 Updates 里。
- **失败与自动暂停**：在 Updates 打开最近一次运行查看错误，重新授权 connector 或修改指令，再用 **Test run** 验证后恢复。「**同一个失败在多次检查中重复出现时，trigger 会自动暂停。**」
- **中途请示**：API 的 task 状态有 `running` / `stopped` / `waiting` / `error`。
  - `waiting` 表示「需要用户确认或输入」，分两类：**提问**（`messageAskUser`、`cascadeAskUser`），用 `task.sendMessage` 回答；**动作确认**，用 `task.confirmAction` 按 `confirm_input_schema` 回答。
  - 确认还没给时发一条普通消息，会**跳过那个动作**，从你的消息继续。
  - 遇到验证码、MFA 时，提示用户接管浏览器，并有单独的「Take Over Notifications」设置。
- **后台工作与重新唤醒**：「`stopped` 不总是最终状态」，要看 `has_running_background_jobs`，后台工作完成后可能再次唤醒这个 task。「之后的一条消息、schedule 或 trigger 也可以再次启动**同一个** Task。」
- **嵌套 / 并行**：Wide Research 部署「数百个独立 agent 并行工作」，每个有自己的上下文、处理一项，主 agent 汇总结果；实测到 250 项。**是否允许嵌套、有没有按方案的上限，文档没写。**

### 1.6 DeepSeek「SuperAgent」

**核实结论：确实存在，但不是 DeepSeek 的消费级产品功能。** 它是 DeepSeek Harness（DSH）团队开源的研究原型 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，本文阅读的是 commit `8c32a9dc`）。README 第一句话就是：「**Research prototype for reference only, not an official DeepSeek product**」，并说明它和内部版本、和配套文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System*（2026-11-01，微信公众号/X，我没读到原文）描述的实现都不完全一致，文章里有些设计只是未来方向。DeepSeek 的聊天 App 里有没有叫 SuperAgent 的功能，我**没有找到任何一手来源**。

它是什么：一个「为单个 GitHub 仓库服务的主动式 coding agent」，打包成 DSH 的 bundle。它监听 GitHub，也可以选择监听飞书；被授权的人向它要活时，它开一个工单，在独立的 session 和目录里工作，然后在原来的对话里回复，例如给出一个 PR。[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)

- **核心原则**：「**占用尽可能少的人类注意力，给出尽可能多的价值。**」只在被要求、或团队写的规则允许时才行动；只在有人必须行动或能用上结果时才说话：确认一次，工作时保持安静，有结果、需要决策或做不完时再开口；**一次只问一个具体问题**，用结构化的形式问。[000-philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md)
- **触发与归属**：Source（GitHub/飞书）→ Trigger → Thread → Eval（确定性的 gate 加模型研判）→ 接单时生成带 **Mandate**（授权的范围、强度、所依据的 Policy 版本）的 **Ticket** → 通过 **Assignment** 交给一个 Executor（每个 Ticket 一个 `worker-<id>` session 和目录）→ 经 Channel 回到来源对话。Eval 不能给自己安排延时 Trigger，需要等待的条件本身就是一个 Source。[001-domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)
- **落点**：同一个 Thread 上后续的人类消息通过 Subscription **扇出到原 Ticket**，不需要再跑 Eval；已结束的 Ticket 会被人的新消息**以原 Mandate 恢复**，bot 和 CI 的消息则不会唤醒它。
- **主动工作的护栏**：accept mode 默认是 `observe`，推断出来的候选工作**只记录「本会接单」，不真正接单**。审阅过记录后再切到 `auto`。[002-authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)
- **执行与无人值守护栏**：[003-execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)
  - Ticket 的阶段由「它在等什么」决定，包括 `person / answer`（有一个 **Attention**，即等人回答的问题）、`person / review`、`person / blocked·failed`、`working / queued`、`idle`。
  - Executor 报告 `blocked`/`failed` 后，**Ticket 不再接收任何自动输入**（CI、bot 消息只记录、不投递、不唤醒），直到有人发消息或点重试。
  - 并发按 worker slot 计。**另外为人的消息或状态查询预留一个 slot**，「新工作不能阻止一个人继续已有的 Ticket」。
  - 一轮结束时还有后台 shell job 或 subagent 在跑的，Ticket 保留 slot，job/subagent 完成后**带着结果唤醒 Executor**。每轮之后后台工作**最多 30 分钟**，超时就杀掉 shell job，报告 waiting。
  - 交给人处理（ready 或提问）时**立即释放 slot**，subagent 停止。
  - 支持全局「暂停处理」：停止派工、Eval、投递和回复，Eval 的截止时间顺延。
- **嵌套**：「Worker subagents, **including nested ones**」用 DSH 的 `standard` preset 和 worker 的权限，只保留 worker 允许的工具，Ticket 结束时失去这些工具。subagent 结束时它的 job 被杀掉。**原型文档里没写嵌套深度上限。**架构是两层：Router（主 Session）对 Worker（每个 Ticket 一个 Executor Session），worker 内部还可以有 subagent。

---

## 2. 对比表

| 维度 | ChatGPT Tasks | Claude 云端 scheduled tasks | Claude Cowork | Claude Code `/loop` | Codex scheduled | Gemini actions / tasks | Manus | DSH SuperAgent |
|---|---|---|---|---|---|---|---|---|
| 触发 | 时间、监控、app 事件/webhook | 时间、API、GitHub 事件（可组合） | 时间、manual | cron、自定节奏唤醒 | RRULE、app 事件（二者不能组合） | 时间；tasks 另有 Gmail/topic monitor | 时间、app 事件、webhook | GitHub/飞书事件（Source） |
| 最短间隔 | 1 小时 | 1 小时 | hourly | 1 分钟 | in-chat 可按分钟 | 每天（actions）/ 每小时（tasks） | 5 分钟 | 事件驱动 |
| 数量上限 | 3–15，按方案 | 100 次/小时/账户，30 次/小时/任务 | 未写 | 50 个/session，7 天过期 | 未写 | 10 个活跃 / 50 个活跃，并发 15 | 未写 | 按 worker slot |
| 归属 | 个人 | 个人账户，以本人身份行动 | 个人 | session | 个人 | 个人 | 个人 | 团队的 bot 身份，按 Mandate |
| 每次触发落点 | 原对话（二手） | **每次新 session**；project 里可接着 thread | 每次新 session | **同一 session** | **standalone 新对话 / in-chat 原对话** | 该 schedule 自己的 chat / task thread | **用户选：同一 task 或新 task** | 原 Ticket（Subscription 扇出） |
| 通知 | push（全平台）+ 邮件（二手） | 运行历史 + 警告 | 手机 push（完成/需批准/失败） | 终端内 | Scheduled 收件箱未读 | 未读标记 + 手机通知 | Updates、接管通知 | 回到来源对话；面板只显示要人处理的 |
| 失败处理 | 未知 | 连接失效跳过 72h 后自动关闭 | 重试约 3.5h，通知首次失败和最终结果 | 不补跑 | 越界调用直接失败 | 不活跃自动关闭 | 同一失败重复后自动暂停；Test run | blocked/failed 后不再自动投递 |
| 中途请示 | 未知 | 权限提示停在该次 session 等人 | 等审批；新一次运行作废旧提示 | 继承 session | 默认不审批（`never`） | 确认后才执行敏感动作；等输入 | `waiting`：提问 / 确认动作 | Attention：一次一个结构化问题 |
| 嵌套深度 | — | — | — | Claude Code 默认 3 | CLI 默认 1 | — | Wide Research 一层并行（是否允许嵌套未写） | worker 内可嵌套，深度未写 |
| 预算 | 方案额度 | 订阅额度 + 小时上限 | 订阅额度 | 继承 | 方案额度 | 用量上限 | credits | slot + 30 分钟后台上限 |

---

## 3. 对 Orqestra 的启示

对照 Orqestra 现有概念：Conversation、Run、Inbox、Wake、Notification、Subagent，见 GLOSSARY 与 ADR 0001。

### 3.1 值得借鉴

1. **一次触发 = 往某个 Conversation 的 Inbox 投一条输入，由它 Wake。** 所有平台的落点都可以归为两类：「每次新会话」（Claude 云端、Cowork、Codex standalone、Manus 新 task）和「回到原会话」（Codex in-chat、Gemini 每个 schedule 一个 chat、ChatGPT、`/loop`、DSH Ticket）。Codex 和 Manus 都把它**做成任务的一个属性**。Orqestra 已经有 Inbox + Wake，两种都不需要新的执行路径：新会话就是先建 Conversation 再投输入，原会话就是直接投输入。建议：
   - **用户创建的 Scheduled Task 默认每次新建 Conversation**，挂在任务下作为运行历史。这样上下文不会无限增长，也和 Compaction 无关。
   - **Agent 延时自唤醒默认回到同一个 Conversation**，即 Claude 的 `ScheduleWakeup`、Codex 的 in-chat 定时。
2. **触发的 prompt 不等于用户的实时同意，外部负载是不可信数据**（Claude 云端）。即使第一期不做 webhook，自唤醒和定时输入也应该以一种区别于 User message 的输入类型进入 Inbox，就像 Claude Code 把完成通知「标为自动事件而不是你的消息」。这与现在 Notification 的地位一致。
3. **频率与数量的硬上限**：用户定时最短 1 小时（ChatGPT、Claude 云端一致），活跃任务数按人设上限（ChatGPT 3–15、Gemini 10）。Agent 自唤醒可以按分钟，但要有 **每个 Conversation 的条数上限**（Claude 50）和 **自动过期**（Claude 7 天）。这些可以作为地图里「Admin 配额数值」的起点。
4. **失败与无人值守**：
   - 首次失败就通知，最终结果再通知一次（Cowork）。
   - 同一失败连续出现 N 次后**自动暂停**（Manus），依赖（例如 MCP Server 不可用）长期失效后**自动关闭**（Claude 72h）。
   - 长期无人互动的任务**自动关闭**（Gemini）。
   - 「Run now / Test run」让用户在启用前试跑一次（Claude、Manus）。
   - 运行结果的状态只说明 Run 怎么结束，不代表工作完成（Claude 明确写了这一点），和我们 Outcome / status 的区分一致。
5. **中途请示是一种「等人」状态，而不是阻塞的工具调用。** Manus 的 `waiting`（提问 / 确认）、DSH 的 Attention、Gemini 的「需要你的输入」都把它做成**可见状态 + 通知**，用户回复后作为普通输入继续。Orqestra 的对应做法：Agent 结束这次 Run 并标记 Conversation「等待用户」，同时发站内或 Web Push 通知；用户的下一条消息照常进 Inbox 并 Wake。这和 Cowork 的教训一致：**不能让无人值守的 Run 卡在一个没人能回答的提示上**，同一任务的新运行应该作废旧的等待。
6. **通知要克制**：DSH「确认一次、工作时安静、有结果/要决策/做不完时再开口」；Codex 把 Scheduled 当作收件箱，只在需要人处理时打未读标记。第一期做「站内未读 + Web Push」与 Gemini、Codex 的形态一致，邮件可以后补（ChatGPT 才有）。
7. **嵌套：带深度上限，到达上限时收回工具，并有整棵树共享的预算。** Claude Code 默认 3 层，到底层**直接从工具列表移除 Agent 工具**（不是调用时报错）；Codex、OpenCode 默认 1。花费上限对整棵树生效，到达时拒绝再派并停掉后台 subagent。ADR 0001 已经有「每条 User message 的 Subagent 启动预算」，建议把它扩成**整棵树共享**，再加一个可配置的深度（建议默认 2，即 Subagent 可以再派一层），到达深度时不提供 subagent Tool。User 的 Stop 照旧级联。
8. **为人保留通道**：DSH 为人的消息预留一个额外 worker slot，「新工作不能阻止人继续已有工作」。如果定时任务和后台 Subagent 挤满了 worker 并发，User 的消息仍然应该优先，可以考虑给定时触发的 Run 用较低的 BullMQ 优先级（推断，未验证 BullMQ Postgres backend 是否支持优先级）。

### 3.2 暂不建议

- **GitHub/webhook/邮件事件触发**：地图已经划为 out of scope。Claude、Codex、Manus 的做法（独立 token、负载包成不可信数据、超限丢弃）留给以后参考。
- **长程计划面板 / 检查点 / SuperAgent 式路由器**：Gemini 的步骤面板、DSH 的 Router + Ticket + Mandate 都是一整套新概念。Orqestra 的 Conversation + Sandbox（持久化、睡眠后文件仍在）本身就是检查点；「等待用户」状态 + 自唤醒已经覆盖暂停/恢复的核心需求。DSH 的 `observe` 模式（只记录「本会做什么」）是为团队 bot 设计的，个人助手场景收益有限。
- **auto mode 分类器 / 审批流**：Orqestra 目前没有权限提示，Tools 都是外部服务。无人值守 Run 的护栏用「哪些 Tool 可用」和预算来做就够了，不必引入审批。
- **不补跑错过的触发**是 Claude `/loop` 的取舍，云端任务则在额度恢复后再跑。Orqestra 的 worker 宕机后，建议**只补一次**而不是逐次补跑（推断，与 Claude 的语义一致）。

### 3.3 仍待确认

- ChatGPT Tasks 每次运行落在原对话还是新对话、失败处理：需要真人打开官方帮助页核对。
- DeepSeek 文章原文里的设计（例如 watchdog、嵌套深度）：原型文档里没有，以原文为准。
