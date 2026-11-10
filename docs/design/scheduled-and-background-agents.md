# 定时任务、后台运行与异步 Agent：设计

> 状态：accepted（2026-11-10）。来源：wayfinder 地图 [#52](https://github.com/zibyn/orqestra/issues/52)，每节标出所依据的决议票。术语以 `GLOSSARY.md` 为准；Subagent 嵌套见 `docs/adr/0001-subagents-are-child-conversations.md` 的修订。

## 1. 目标与非目标

**目标**

- User 在 UI 建 **Scheduled Task**，按计划自动开新 Conversation 跑一次（**Firing**）。
- Agent 能设 **Timer**，过一段时间回到本 Conversation 继续干活。
- Agent 能在 Run 中途向 User 提一个 **Question**，提完就结束 Run，等 User 回复。
- 后台有结果时，用 **Alert**（Web Push）告诉 User；站内只有 **Unread**。
- 无人盯着的 Run（**Unattended Run**）有步数和墙钟上限。
- Subagent 可以嵌套，层数由 Admin 定。
- Agent 能起草 **Task Draft**，由 User 保存成 Scheduled Task。

**非目标**（地图 Out of scope）：外部事件触发（Webhook / 邮件 / MCP 事件）；token / 花费计量和花费上限；Tool 级审批；SuperAgent 式路由器、计划面板、检查点；通知中心；邮件通知；Agent 直接创建 Scheduled Task。

## 2. 现状（改动的起点）

- 所有输入先进 `inbox`，`ensureRun` 在根会话锁内决定是否启动 Run，Run 在步骤边界 drain inbox，直到 inbox 为空才结束（`docs/design/subagent-sessions.md`）。
- 两个 BullMQ 队列：`agent-runs`、`subagent-runs`，Postgres backend。
- `lockRoot` 和事件频道都假设根就是 `coalesce(parent_id, id)`，即只有一层。
- `conversation.subagents_since_user` 记在启动它的会话上；`MAX_SUBAGENTS = 4` 按同一父会话计。
- 控制台没有「Limits」分组；限额都是代码常量（`MAX_SUBAGENT_STEPS`、`MAX_SUBAGENTS_PER_USER_MESSAGE` 等）。

## 3. 数据模型方向

只给方向，列名和类型实现时定。

```
scheduled_task                        -- 新表；只对 user_id 可见，Admin 也不可见
  id, user_id, name, prompt (text)
  agent_id, model, thinking_level
  schedule      jsonb   -- { kind: 'once', at } | { kind: 'every', seconds } | { kind: 'cron', expr }
  ends_at       null    -- 仅周期任务
  time_zone
  incognito, alert_on_complete (默认 true), enabled
  state         'active' | 'paused' | 'auto_paused' | 'finished'
  consecutive_failures int
  created_at, updated_at

firing                                -- 新表；一次 Firing 一行，随任务级联删除
  id, task_id → scheduled_task on delete cascade
  fired_at
  outcome       'running' | 'completed' | 'partial' | 'question' | 'skipped' | 'failed'
  reason        text null              -- skipped / failed 的原因
  conversation_id → conversation on delete set null   -- skipped、开会话前就失败的为 null

timer                                 -- 新表；每个 Conversation 至多一行
  conversation_id pk → conversation on delete cascade
  note, rings_at
  message_id    -- 设下它的那次 Tool 调用所在的 message，Retry 删到它时连带删除
  model, thinking_level                -- 沿用设下它的 Turn

push_subscription                     -- 新表；一个浏览器一行
  id, user_id, endpoint unique, keys jsonb, created_at

limits                                -- 新表，单行；控制台「Limits」分组，实时生效
  max_scheduled_tasks_per_user  10
  min_firing_interval           1h
  timer_rings_per_user_message  10
  unattended_max_steps          50
  unattended_max_duration       30min
  max_subagent_depth            2   (1–3)

conversation
  + scheduled_task_id  → scheduled_task on delete set null   -- 删除任务后回到普通列表
  + root_id, depth     -- 嵌套后按真根加锁、计预算；顶层会话 root_id = id, depth = 0
  + unread             boolean
  + awaiting_reply     boolean   -- 以 Question 结束的 Run 置真，下一条 User 消息清掉
  + unattended         boolean   -- Firing / Timer 输入置真，User 消息清掉
  + timer_rings_since_user int
  ~ subagents_since_user         -- 只在根上计数

inbox / message
  + origin  null | 'task' | 'timer'   -- 「由 Scheduled Task 代发」「由 Timer 送达」的标记
```

**Task Draft 不建表**：草稿就是 `draft_scheduled_task` Tool 调用的参数，存在 message 里，卡片从这次调用渲染（[#62](https://github.com/zibyn/orqestra/issues/62)）。

**Question 不建表**：就是 `ask_user` Tool 调用，加上 `awaiting_reply` 标记（[#60](https://github.com/zibyn/orqestra/issues/60)）。

## 4. 流程

### 4.1 Scheduled Task 与 Firing（[#54](https://github.com/zibyn/orqestra/issues/54)、[#55](https://github.com/zibyn/orqestra/issues/55)、[#58](https://github.com/zibyn/orqestra/issues/58)）

- **排期**：新队列 `firings`。周期任务用 BullMQ Job Scheduler，scheduler id 就是任务 id：创建或编辑时 upsert（cron + tz，或 every），暂停、结束或删除时移除。一次性任务用 delayed job，jobId 取 `task:<id>:<at>`。Scheduler 只投递 `{ taskId }`，不直接跑 Run。停机期间错过的不补跑。
- **校验**（API 边界）：Agent 是 User 可选的；Model 和 thinking 在该 Agent 允许范围内；周期间隔不短于 `min_firing_interval`（Cron 按接下来两次触发的间隔算）；每人任务数不超过上限。
- **Firing 处理**（worker，`firings` 队列）：

```
锁住任务行
if 任务不是 active：丢弃
if 上一次 Firing 的 Conversation 在 running：记 firing(skipped, reason)；结束   -- 等 Question 不算 running
if Agent 不可选 或 Model 已停用：记 firing(failed, reason)；计一次失败；结束
新建 conversation(scheduled_task_id, incognito, unattended = true)
inbox 写入首条 User 消息(origin = 'task', wake)
记 firing(running, conversation_id)
提交后 ensureRun
一次性任务 或 已过 ends_at：state = finished，发 Alert(d)
```

- **结果回写**：这个 Conversation 的**第一个 Run 结束时**回写 firing.outcome，取值 completed / partial / question / failed。之后 User 在里面回复，不再改 Firing 的结果。
- **连续失败**：failed 时 `consecutive_failures + 1`，其他结果清零，skipped 不计。到 3 时 state = auto_paused，移除 scheduler，发 Alert(d)。3 是固定值。
- **编辑**：从下一次 Firing 生效（重新 upsert）。**删除**：移除 scheduler，删除任务，firing 级联删除，Conversation 的 `scheduled_task_id` 置空。

### 4.2 Unattended Run 的护栏（[#58](https://github.com/zibyn/orqestra/issues/58)）

- 判断：Run 开始时 `conversation.unattended`（Subagent 看根的值）。Firing / Timer 的输入置真，User 消息清掉。
- **步数**：上限 `unattended_max_steps`，倒数第二步注入现有的 `STEP_LIMIT` 让 Agent 收尾，结果是 `partial`。Subagent 保留自己的 20 步上限。
- **墙钟**：超过 `unattended_max_duration` 就 abort，按 `partial` 收尾，走 Stop 的那条路，但不算 User 停的，照发 Alert。
- Notification 唤醒的后续 Run 仍然无人值守，各自重新计步、计时。
- 不做 Run 级自动重试：Timer 引起的 Run 失败时，Conversation 记为 `failed` 并发 Alert。

### 4.3 Timer（[#56](https://github.com/zibyn/orqestra/issues/56)）

- **Tools**（只给顶层 Agent）：`set_timer(delay, note)`，delay 从 1 分钟到 24 小时；`cancel_timer()`。
- **set**：upsert `timer` 行（替换旧的），同时加一个 delayed job（队列 `timers`，jobId `timer:<conversationId>:<rings_at>`）。如果 `timer_rings_since_user` 已经达到上限，Tool 报错，要求 Agent 结束本轮并告诉 User。
- **响**：

```
锁根
timer 行不在 或 rings_at 对不上：丢弃        -- 取消只删行，不依赖能否删掉 job
删 timer 行；timer_rings_since_user + 1；unattended = true
inbox 写入 note(origin = 'timer', wake, model / thinking 取 timer 行)
提交后 ensureRun
```

- **取消**：只删 `timer` 行，能删掉 job 就顺手删。触发取消的情况：User Stop、Retry 的范围包含 `message_id`、ask_user、删除 Conversation（级联）、`cancel_timer`、UI 上的取消按钮。User 发新消息不取消 Timer，只把 `timer_rings_since_user` 清零。
- **展示**：Conversation 里显示「将于 14:30 回来查看：<note>」和取消按钮。Timer 待响期间 status 仍是 idle。

### 4.4 Question（[#60](https://github.com/zibyn/orqestra/issues/60)）

- **Tool**（只给顶层 Agent）：`ask_user(question, suggestions?: 2–4)`。调用后本步结束，Run 收尾：`awaiting_reply = true`，取消 Timer。一个 Turn 最多调用一次，第二次调用时 Tool 报错。
- **等待期间**：Notification 照常写进 inbox，但 `ensureRun` 在 `awaiting_reply` 时不因它们启动 Run，等 User 回复时一起投递。User 消息照常唤醒，并清掉 `awaiting_reply`。
- **撤回**：Retry 提问的那个 Turn，或删除 Conversation。不设超时。
- **UI**：问题下面把建议答案显示成按钮，点按钮就是发出那段文字；自由输入始终可用。列表里「等你回复」和 Unread 用不同的标记。

### 4.5 Subagent 嵌套（[#59](https://github.com/zibyn/orqestra/issues/59)，ADR 0001 修订）

- `lockRoot`、事件频道、Stop、预算都改成按 `root_id` 走。启动 Subagent 时 `depth = 父.depth + 1`；`depth = max_subagent_depth` 的那一层不给 Subagent Tools。
- **预算**：启动和续跑合计 16 次，记在根上，只有根收到 User 消息才清零。同时运行的上限改为整棵树 4 个，按 root_id 数正在跑的 Subagent。
- **中间层结束**：Run 结束时，如果还有直接子 Subagent 处在 queued 或 running，就不写结果、不发 Notification，outcome 保持 running；status 变成 idle，不占名额。最后一个子 Subagent 的 Notification 唤醒它之后，它再跑一个汇总 Run，结束时才发 Notification。
- **Stop**：停掉被停会话以下的整棵子树，后代的 Notification 都是 `wake = false`。
- **事件**：子孙的 start / delta / end 发到根的频道，带上子会话 id。面板里往下钻，按子会话加载 transcript，顶部显示面包屑。

### 4.6 Alert 与 Unread（[#57](https://github.com/zibyn/orqestra/issues/57)）

- **Unread**：顶层 Conversation 的 Run 结束、带着 User 还没看过的回复时置真；User 的 Run 被 Stop 时不动它。打开 Conversation（API 一次 `seen` 调用）时清掉。
- **Alert 时机**，每次 Run 至多一条：
  - (a) 顶层 Conversation 的 Run 结束，User 自己 Stop 的除外；以 Question 结束的发「等你回复」；
  - (b) Firing 在开出 Conversation 之前就失败（Firing 的 Run 失败时已由 (a) 发出，不重复发）；
  - (d) Scheduled Task 自动暂停或自动结束。
  - 由 Firing 开启的 Conversation，如果任务关了 `alert_on_complete`，completed / partial 的 (a) 不发，failed 和 Question 照发。
- **发送**：worker 在 Run 收尾时向该 User 的所有 `push_subscription` 发 Web Push；返回 404 / 410 的订阅直接删除。payload 只有 `{ title, status, url }`，不带正文，Incognito 也一样。
- **Service Worker**：收到推送时，如果有已聚焦的窗口正显示 `url`，就不弹出。点 Alert 打开 `url`：(a) 打开 Conversation；(b)(d) 打开 Scheduled Task 的抽屉，如果有对应的 Conversation 就打开 Conversation。
- **部署**：VAPID 公私钥放在环境变量里，与 `ORQESTRA_ENCRYPTION_KEY` 同类，需要 HTTPS。没有配置时，设置里不出现「在此浏览器接收 Alert」开关，其余功能照常。Web Push 库在实现时选（候选 `web-push`）。

### 4.7 Task Draft（[#62](https://github.com/zibyn/orqestra/issues/62)）

- **Tool**（顶层 Agent 内置，Unattended Run 里也有，Subagent 没有）：`draft_scheduled_task(name, prompt, schedule, ends_at?)`。用与 4.1 相同的校验（包括最短间隔），不合格就报错；通过就立即返回「草稿已展示，User 尚未创建」，不结束 Run，也不限数量。
- **卡片**：显示名称、提示、计划摘要、下次 Firing 时间，以及「打开并创建」按钮。点按钮打开预填好的 `FormSheet` 抽屉，默认值：Agent / Model / thinking 取起草的那个 Turn，Incognito 随本 Conversation，时区取浏览器，Alert 和启用都打开。保存走普通的创建接口。卡片不记录有没有被保存，可以重复保存。

## 5. UI（[#61](https://github.com/zibyn/orqestra/issues/61)，原型分支 `prototype/scheduled-task-ui`）

- **「定时任务」页**：用户菜单里和 Memory 并列，用 `ConsolePage` + `ItemList`。每行显示名称、状态徽标、Incognito 图标、计划摘要、下次 Firing 时间、上次结果、启用开关、「打开」。
- **抽屉**（`FormSheet`）：新建和编辑共用。依次是：名称、提示、Agent / Model / thinking、计划（一次 / 每隔 / Cron，Cron 显示人话描述和接下来 3 次时间；周期任务可设结束日期）、时区、Incognito、完成时发 Alert、启用。表单下面是运行记录，按时间倒序，一次 Firing 一行。
- **侧栏**：「定时任务」分组排在 Conversations 之上，按任务折叠，每个任务列最近几个 Firing Conversation。有 Unread 时任务名加粗，自动暂停时显示错误图标。Firing 的 Conversation 不进普通列表。
- **Conversation 内**：Timer 条（含取消按钮）、Question 的建议答案按钮、Task Draft 卡片、Subagent 面板的面包屑。
- **设置**：「在此浏览器接收 Alert」开关（只在配置了 VAPID 时出现）。
- **控制台**：新的「Limits」分组，内容就是 §3 的 `limits`。

## 6. 分期

每期都能单独上线。无人值守的护栏必须先于 Firing 和 Timer 上线。

1. **Limits 分组 + 护栏底座**：`limits` 表和控制台页面；`conversation.unattended` 和 `origin`；按 Unattended Run 计步和墙钟上限。现有 Run 都是有人值守的，所以这一期行为不变。
2. **Unread + Question**：`unread`、`awaiting_reply`、`ask_user`、等待期间暂存 Notification、列表标记。
3. **Scheduled Task + Firing**：表、`firings` 队列、API 和校验、「定时任务」页、抽屉、运行记录、侧栏分组、连续失败自动暂停。
4. **Alert**：VAPID、`push_subscription`、Service Worker、§4.6 的三类时机。
5. **Timer**：`timer` 表、`timers` 队列、两个 Tool、取消路径、Conversation 内的 Timer 条。
6. **Subagent 嵌套**：`root_id` / `depth` 迁移，lockRoot、预算、并发、Stop、事件改为按根走，中间层延后发 Notification，面板面包屑。
7. **Task Draft**：Tool、卡片、预填抽屉。依赖第 3 期。

依赖：3、5 依赖 1；4 依赖 2、3（「等你回复」和 Firing 类 Alert）；7 依赖 3；1、2、6 可立即开工。

## 7. 实现时核实

- BullMQ Postgres backend 的 Job Scheduler 在 upsert 时能否同时改 cron 和 tz，以及删除后已经投递、尚未处理的 job 会怎样。§4.1 在处理 Firing 时重查 state，已经兜住了这种情况。
- delayed job 能否按 jobId 删除。§4.3 用「行不在就丢弃」兜住了，删不掉也没关系。
- 墙钟 abort 和 User Stop 共用 `requestStop` 路径时，怎么区分「是不是 User 停的」，这决定 Alert 和 Unread 的处理。
- Cron 的最短间隔按「接下来两次」检查，对不规则的 cron（如 `0 9,10 * * *`）是否足够，还是要检查接下来 N 次。

## 8. 已知风险

- **Firing 风暴**：很多任务落在同一分钟（比如整点）时，`firings` 只负责开 Conversation，真正的负载在 `agent-runs`，由 worker 的 concurrency 和 `providerLimiter` 兜底。不设每人并发上限是有意为之（#58）。
- **重复创建**：Task Draft 可以重复保存，第一期接受。
- **Alert 泄露标题**：payload 带 Conversation 标题，锁屏上可能看到，Incognito 也一样。这是 #57 的决定。
