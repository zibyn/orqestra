# Subagent 作为子会话：设计

> 状态：accepted（2026-10-29）。决策见 `docs/adr/0001-subagents-are-child-conversations.md`。

## 1. 目标

- Subagent 和 Claude Code 的后台 agent 一样：父 Agent 启动后继续工作，**不需要等待工具**；Subagent 完成后，由 Notification 把父 Agent **唤起**。
- Subagent 的生命周期**不再跟 Run 绑定**：父 Agent 已经回复完、用户在发新消息、worker 重启，Subagent 都照常进行或能恢复。
- Subagent 是一个**独立的会话**：消息逐条落库，回复流式输出，可以压缩，可以单独停止，父 Agent 还能继续给它派活。
- 不变的部分：不允许嵌套，Subagent 只看到 brief，Subagent 只对拥有它的 User 可见。

## 2. 核心模型

| 概念 | 含义 |
|---|---|
| 子 Conversation | 每个 Subagent 就是一个 `conversation` 行，`parent_id` 指向启动它的 Conversation。复用现有的 message、Run、压缩、重试和流式机制 |
| `subagent` 行 | 只存元数据：编号、模板、启动它的 Tool 调用、outcome、result。**不再存 transcript** |
| Inbox | 进入一个 Conversation 的所有输入先写进 `inbox` 表：User 消息、Notification、父 Agent 发给 Subagent 的消息。Run 投递一条，就从 inbox 删一条，同时插入 `message` 表 |
| Notification | Subagent 结束时写进父 Conversation inbox 的一条输入：`<task-notification subagent="2" status="completed">…</task-notification>` |
| 唤起 | 一条 `wake = true` 的 inbox 输入到达，而这个 Conversation 没有 Run 在跑时，就启动一个 Run |

为什么要有 inbox 表，而不是把输入直接插进 `message` 表：`message.id` 决定模型看到的顺序。如果 Notification 在父 Agent 两个步骤之间直接插入，可能落在某个 toolCall 和它的 toolResult 之间，provider 会拒绝这样的上下文。改为先写 inbox，等 Run 在步骤边界投递时再插入 `message`，id 顺序就天然正确。

## 3. 数据模型

```
conversation
  + parent_id        uuid null → conversation.id on delete cascade   -- null 表示顶层会话
  ~ agent_id         改为可空：null 表示内置的 general worker（只有子会话会用到）

subagent                                       -- 一行对应一个子会话
  conversation_id    uuid pk → conversation.id on delete cascade     -- 子会话
  parent_id          uuid → conversation.id on delete cascade
  tool_call_id       text      -- 启动它的那次 subagent 调用，UI 据此把卡片挂到这次调用下面
  number             int       -- 在父会话内单调递增；unique(parent_id, number)
  template           text null
  outcome            'queued'|'running'|'completed'|'partial'|'failed'|'stopped'
  result             text null
  created_at
  - messages jsonb  （删除，transcript 改存到子会话的 message 行）

inbox
  id                 serial pk
  conversation_id    uuid → conversation.id on delete cascade
  message            jsonb     -- pi UserMessage
  model, thinking_level        -- 和 message 表一样，记下这条输入选用的模型和思考档位
  subagent_id        uuid null -- 设置了就表示这是一条 Notification，指向发出它的子会话
  wake               boolean   -- false：下一个 Run 顺带投递，但不会因此启动 Run
  created_at

message
  + subagent_id      uuid null -- Notification 投递后保留这个链接，UI 把它画成「子智能体 2 已完成」并能点开
```

列表页只显示顶层会话：`listConversations` 加上 `parent_id is null` 条件。

## 4. 流程

所有状态迁移都在**父会话行的 `select … for update` 锁**里进行，这把锁就是并发上的唯一真相。Postgres 锁内只做数据库写入；入队（BullMQ）放在提交之后执行，失败时沿用现有的处理方式，把状态标成 failed。

### 4.1 ensureRun(conv)，唯一的启动入口

```
锁住 conv 的根会话（子会话锁父会话）
if conv.status != 'running' and inbox 里有 wake 输入 and 还有名额:
    conv.status = 'running'；子会话把 outcome 设为 'running'
    提交后 enqueue(conv)
```

- 名额：顶层会话不受限制；子会话要求同一父会话下正在跑的子会话少于 `MAX_SUBAGENTS`（4）。没有名额的保持 `queued`，等有兄弟会话结束时再拉起。
- 以下几处都调用它：sendMessage、启动 Subagent、发 Notification、`subagent_message`、Run 结束时（拉起排队的兄弟会话）。

### 4.2 Run 的主循环（runTurn）

```
drain()：锁内取出 inbox 全部条目 → 插入 message → 删除 inbox 条目 → 返回这些消息
messages = 历史 + drain()
loop:
    agent.continue()
      · prepareNextTurn：每个步骤之后调用 drain()，有新输入就作为本步之后的消息交给模型
    锁内：inbox 为空 → 结束（顶层会话 status = idle；子会话见 4.4）；否则 drain() 并接着循环
```

「Run 只在 inbox 为空时才进入 idle」和「投递方看到 idle 才启动 Run」都在同一把锁里判断，所以不会漏掉输入，也不会同时出现两个 Run。

### 4.3 父 Agent 的 Tools

| Tool | 行为 |
|---|---|
| `subagent(tasks[])` | 锁内为每个任务创建子会话、`subagent` 行（编号取 max+1）和一条 brief 输入（wake），然后对每个子会话调用 ensureRun。立即返回「已启动 3、4」 |
| `subagent_message(n, text)` | 往子会话的 inbox 写一条 wake 输入，再调用 ensureRun。子会话正在跑时，下一步就能读到；已经结束的会被**续跑**（相当于 Claude Code 里用 SendMessage 恢复一个 agent），结束后会再发一条 Notification |
| `subagent_stop(ns)` | `NOTIFY STOP_CHANNEL` 发出子会话 id（复用现有的 `active` 表，按会话 id 做 abort）。排队中的直接标成 stopped。被停止的子会话也发 Notification，但 `wake = false` |
| ~~`subagent_wait`~~ | 删除。结果通过 Notification 送达；父 Agent 想等结果，结束这一轮回复即可 |

工具说明里要写明：「结果会以 `<task-notification>` 的形式送达，不要轮询；在所有需要的结果到齐之前，可以先告诉用户你在做什么，然后结束本轮。」

### 4.4 子会话结束

子会话的 Run 在 4.2 中把 inbox 清空之后：

```
锁住父会话
subagent.outcome / result = 由最后一条回复得出（completed/partial/failed/stopped，判定逻辑同现在）
子会话 status = idle
往父会话 inbox 写 Notification（wake = outcome 不是 stopped）
ensureRun(父会话)；ensureRun(下一个排队的兄弟子会话)
```

Notification 里的 result 沿用现有的转义方式，把 `</task-notification` 替换掉，防止被提前闭合。

### 4.5 停止、崩溃、重试、删除

- **用户点停止**（顶层会话）：停止父会话的 Run，以及它所有正在跑和排队的子会话；这些子会话的 Notification 都是 `wake = false`，下次用户发消息时才一并交给模型。
- **崩溃**：job 失败时，worker 在 `failed` 回调里区分处理。顶层会话标成 failed，和现在一样；子会话的 outcome 记为 failed，并给父会话发一条**会唤起它**的 Notification，内容写明「worker 崩溃」。这样父 Agent 能感知并决定重派。
- **重试**：删掉最后一条**输入**（User 消息或 Notification）之后的 message；对删除范围内 subagent 调用所启动的子会话，先停止再删除。删除子会话会级联删掉 `subagent` 行、inbox 和 message。
- **删除会话**：先给仍在跑的子会话发 stop，再删除（级联删除）；子会话的 Run 开始时会检查自己是否还存在，这是现成的 `deleted while queued` 分支。

### 4.6 防止失控

唤起意味着可能出现「Notification → 父 Agent 再派 Subagent → 再收到 Notification」的无限循环。预算按「自上一条 User 消息以来」计算：

- 启动 Subagent 加上续跑 Subagent，合计不超过 `MAX_SUBAGENTS_PER_TURN`（16）；超出时 Tool 报错，要求父 Agent 自己完成剩下的工作。
- 每次唤起最多对应一次 Subagent 的结束，所以唤起次数自然受上面这个预算约束，不需要单独计数。

### 4.7 队列

- 拆成两个队列：`agent-runs`（顶层会话）和 `subagent-runs`（子会话），各有一个 Worker 和各自的 concurrency。这样子会话再多，也不会把其他用户的主对话饿死。
- job 数据保持 `{ conversationId }`；runTurn 根据有没有 `subagent` 行来决定 Tool 集合、system prompt（模板的 instructions 或 GENERAL_WORKER）、步数上限，以及最后一步不给 Tools 的规则。
- 子会话的 model 和 thinking 记在 brief 那条输入上（继承父会话，或用模板的默认值），走现有「每条 user 消息记录自己的 model」机制，不需要新增字段。`resolveTurn` 需要支持 `agentId = null`，也就是 general worker 的情况。
- `providerLimiter` 不变，仍按进程计算。

## 5. 事件与 UI

- 事件协议沿用上一版：`start`、`delta`、`end` 带上 `subagent`（等于子会话 id），**发到父会话的频道**，这样父页面的卡片能显示实时预览。不允许嵌套，所以父会话一定是根会话。
- 父会话的 `getConversation` 只返回子会话的元数据（编号、模板、brief、outcome）。transcript 改为**打开面板时再按子会话加载**，顺带解决现在「每次 reload 拉取全部 transcript」的 shortcut。
- 面板就是一个只读的会话视图，额外提供一个「停止」按钮；User 不能在面板里给 Subagent 发消息，结果只交给启动它的 Agent。
- Notification 消息在父会话里显示成一行系统提示：「子智能体 2 · 已完成」，点击打开面板。
- Composer：父会话 idle 时始终可以输入，后台还有 Subagent 在跑也不影响。侧边栏给后台还有子会话在跑的会话加一个标记。
- 父会话 running 时用户发消息：写进 inbox，在下一个步骤边界投递，不再报「A reply is still being generated」。

## 6. GLOSSARY 改动（已写入）

- **Subagent**：一个 Agent，在**自己的 Conversation**（嵌套在启动它的那个 Conversation 之下）中执行一项任务，从全新的上下文开始。它可以比启动它的 Run 活得更久；结束时用一条 Notification 把结果交回去。启动它的 Agent 可以继续给它发消息或停止它；User 只能查看和停止它。Subagent 不能再启动 Subagent。
- **Notification**（新）：Subagent 结束时交给启动它的 Agent 的一条输入，里面带着结果。这个 Agent 当时没有 Run 在跑时，Notification 会启动一个新的 Run。
- **Turn**：一条输入（User 消息或 Notification）加上 Agent 对它的回复。
- **Run**：……每个 Conversation 同一时间最多有一个 Run；Subagent 在自己的 Conversation 里有自己的 Run，停止一个 Run 不会影响其他 Conversation 的 Run（用户点停止时除外，见 4.5）。
- **Conversation**：……一个 Subagent 的 Conversation 嵌套在启动它的 Conversation 之下，只能通过那个 Conversation 看到。

## 7. 分阶段实施

1. **Schema + inbox + ensureRun**：迁移（conversation.parent_id，agent_id 改为可空，subagent 删掉 messages、加上 parent_id/outcome，新增 inbox 表，message 加 subagent_id），并把现有的 sendMessage 改成走 inbox。这一阶段行为不变，现有测试应当全部通过。
2. **子会话 Run + Notification 唤起**：新增 `subagent-runs` 队列，runTurn 的主循环改成「直到 inbox 为空」，重写三个 Tool，删除 `subagent_wait` 和 `close()`，处理结束、崩溃和重试。测试至少覆盖：父会话先回复完、子会话后完成并唤起父会话；两个子会话同时完成时只唤起一次 Run 并投递两条；父会话 running 期间到达的 Notification 在步骤边界投递；续跑一个已完成的子会话；子会话崩溃时唤起父会话；名额排队；预算耗尽。
3. **UI**：按需加载面板、Notification 行、侧边栏标记、停止按钮。
4. **running 时排队 User 消息**：机制在第 1 阶段已经具备，这里放开 Composer 和 sendMessage 的限制，并测试 running 期间发的消息在下一个步骤边界被投递。

## 8. 已知风险

- **提交和入队之间崩溃**：会话会一直停在 running。现在的 sendMessage 已经有这个缺口，唤起让触发点变多了。可以在 worker 启动时做一次扫描：把「running 但没有对应 job」的会话重新入队。建议放在第 2 阶段一起做。
- **NOTIFY 流量**：4 个子会话加上父会话同时流式输出，每个 delta 都是一次 `pg_notify`。量级和现在的单流相同，乘以并发数后仍然可以接受；如果出问题，可以在 relay 里按 50ms 合并。

## 9. 已定决策

1. 用户点停止时，连同所有后台 Subagent 一起停止（见 4.5）。
2. 父会话 running 时，用户发的消息排队，在下一个步骤边界投递（见第 5 节、第 4 阶段）。
3. 用户不能在 Subagent 面板里给它发消息，只能查看和停止。
