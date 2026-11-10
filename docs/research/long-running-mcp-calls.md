# 其他平台怎么处理长时间运行的 MCP Tool 调用

> 调研日期：2026-11-10。对应 #89（地图 #76 的子票，阻塞 #85）。
>
> 只采用一手来源，读取时间都是 2026-11-10：
> - Tasks 扩展规范和 SDK：`modelcontextprotocol/ext-tasks@cc9aaac`。规范文件是 `specification/2026-07-28/tasks.md`，客户端包是 `packages/ext-tasks`（npm 0.2.3），文档在 `typescript/client/*.md`
> - 官方 TypeScript SDK：`modelcontextprotocol/typescript-sdk@1e608ca`（`@modelcontextprotocol/client` 2.4.0）
> - 扩展支持矩阵：`modelcontextprotocol/modelcontextprotocol@632a0c9` 的 `docs/extensions/client-matrix.mdx`
> - Claude Code：官方文档 `https://code.claude.com/docs/en/mcp.md` 和 `https://code.claude.com/docs/en/headless.md`；`anthropics/claude-code` main 分支的 `CHANGELOG.md`
> - VS Code / GitHub Copilot Chat：`microsoft/vscode@4991a88ff5` 的 `src/vs/workbench/contrib/mcp/common/`
> - GitHub Copilot CLI：`github/copilot-cli` main 分支的 `changelog.md`
> - MCPJam：`MCPJam/inspector@8cef246124`
> - ChatGPT / Codex：`https://developers.openai.com/plugins/build/extensions.md`、`.../plugins/build/mcp-events.md`、`https://learn.chatgpt.com/docs/extend/mcp.md`
> - Cursor：官方文档和 changelog 都没能读取（请求被拒），只引用了论坛里 Cursor 员工的答复
>
> 背景（不再重复）：规范要点和 pi-mcp 不支持 Tasks 的结论，见 `origin/research/mcp-2026-07-28` 分支上的 `docs/research/mcp-2026-07-28.md`。
>
> 标「推断」的内容没有直接出处。

## 结论

1. **真正支持 2026-07-28 Tasks 扩展、并且公开了行为细节的产品，只有 Claude Code CLI。** 它的做法是「立刻转后台，结果作为新消息交回」。服务端一返回 task，这次 tool call 就结束了：模型拿到的工具结果只是「已转到后台」。任务结束后，结果作为一条 task notification 交给模型；模型空闲时，这条通知会让它自己开始干活。这就是 Orqestra 的 Notification 加 Wake。
2. **所有实现都靠轮询 `tasks/get`，没人用 `subscriptions/listen` / `notifications/tasks`。** Claude Code 明说不用通知。官方 SDK 默认轮询，收到推送也接受。VS Code（2025-11-25 版）以轮询为主，同时接收 `notifications/tasks/status`。轮询间隔都遵守服务端给的 `pollIntervalMs`，并设上下限。
3. **能取消的地方都是「停止跟踪 + 发 `tasks/cancel`」，并且都承认服务端可能照样做完。** Claude Code 会告诉模型「不会有结果了」。VS Code 和 Cursor 取消一轮对话时只在本地放弃，不通知服务端。
4. **`input_required` 只在有人能回答时才交给用户，否则取消任务。** Claude Code 在交互式会话里弹出 elicitation 对话框，在非交互式会话里直接 `tasks/cancel`。MCPJam 的自动化模式会返回确定的 `input-required` 结局，不会一直挂着。
5. **收尾时任务的寿命和会话或进程分开。** 退出 Claude Code 不会取消远端任务，resume 同一会话后会接着跟踪。新开会话或 fork 都不继承任务。官方 SDK 把选择交给调用方：`detach()` 让任务继续跑，`close()` 尽力取消。
6. **2025-11-25 的实验版 Tasks 由客户端逐请求要求（`params.task`，看 Tool 的 `execution.taskSupport`），2026-07-28 改由服务端决定。** VS Code 和 Copilot CLI 只实现了 2025-11-25 版。VS Code 在原地阻塞等待；Copilot CLI 把 `taskSupport: "required"` 的 Tool 当成后台 agent 来跑。
7. ChatGPT、Cursor、Codex 都没有 Tasks。claude.ai（web）在支持矩阵上有勾，但我**找不到**任何描述它行为的公开文档。

## 1. 规范对客户端的要求（只列和 #85 相关的）

出自 `ext-tasks/specification/2026-07-28/tasks.md`：

- **是否创建任务由服务端决定。** 客户端只需在每个请求的 `_meta` 里声明 `io.modelcontextprotocol/tasks`。声明之后，任何 `tools/call` 都可能收到 `CreateTaskResult`（`resultType: "task"`），客户端必须两种结果都能处理（§Capability Negotiation）。
- **轮询。** 客户端 SHOULD 遵守 `pollIntervalMs`，这个值可能会变；服务端 MAY 限流。客户端 SHOULD 一直轮询到终态或取消，并且 SHOULD **把 taskId 持久化**，以便崩溃或重启后继续（§Task Polling）。
- **TTL。** `ttlMs` 可以是 `null`。过了 TTL，服务端 MAY 把任务标成 failed，然后随时删除；客户端 MAY 把 TTL 当作兜底（§Task Polling）。任务过期后，`tasks/get` 返回 `-32602`，这是合规行为（§Error Handling）。
- **输入。** `input_required` 时，`tasks/get` 带回 `inputRequests`，客户端用 `tasks/update` 回答。每一项都要按独立的 `elicitation/create` 那样对待，信任模型相同；客户端 SHOULD 跨轮询去重（§Task Update Requests，§Security「A task is not a higher-trust channel」）。
- **取消。** `tasks/cancel` 是协作式的，服务端只负责确认收到，不保证停下，最终状态也不一定是 `cancelled`。客户端发出取消后 MAY 立即删掉本地状态，不必等到 `cancelled`（§Task Cancellation）。
- **通知是可选的。** 服务端 MAY 推送 `notifications/tasks`，客户端要先发 `subscriptions/listen` 订阅（§Task Status Notifications）。任务上不支持 `notifications/progress`，进度只能通过 `statusMessage` 表达。
- **结果。** `completed` 的 `result` 就是原本 `tools/call` 会返回的结果，`isError: true` 也属于 completed；`failed` 只用于 JSON-RPC 错误（§Task Execution Errors）。
- **鉴权。** 服务端 MUST 对每个 task 请求做鉴权（§Security「Auth binding」）。Streamable HTTP 上 MUST 把 `Mcp-Name` 设为 taskId（§Routing Headers）。
- **兼容。** 旧客户端可以在内部偷偷轮询，对外只交出最终结果（§Backwards Compatibility）。这正是「原地阻塞」这种做法的规范依据。

## 2. 各家做法

### 2.1 Claude Code（CLI，Tasks 扩展公开测试版）

出处是 `code.claude.com/docs/en/mcp.md` 的 §Automatic backgrounding of long tool calls、§MCP tasks that run on the server、§MCP tasks for server authors，以及 CHANGELOG。

**什么时候算 MCP task。** 需要 v2.1.304 以上；服务端连接在 2026-07-28 协议上；会话是终端 CLI、Agent SDK 或 GitHub Actions；调用来自主对话而**不是 subagent**。VS Code 扩展和桌面版没有这个功能。调用不满足这些条件时，不声明扩展，按普通调用处理（§What a call needs to become an MCP task）。

**一轮怎么等：默认立刻转后台。**「Claude's tool call returns once the server accepts the job, so Claude keeps working」。2.1.319 的 changelog 写的是「moves it to the background right away and tells Claude the result when it finishes」。

- 另有一种「先等一段再转后台」的做法，但它针对的是**普通**（非 task）调用：主对话里超过 2 分钟的 MCP 调用会自动转后台，阈值用 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` 配置（2.1.212 引入）。打开 `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1` 后，task 先在原地等，2 分钟后再按普通后台调用转走，只是这样就不能跨会话存活了。
- 原地等待的过程中，按 Esc 或者碰到超时都会结束这次调用，并向服务端发 `tasks/cancel`。

**结果怎么交回：新消息。** 后台调用的工具结果是一个 task ID（「Claude receives the task ID immediately」），结果「arrives as a task notification」。transcript 里只出现一行 `MCP task <id> (<server>/<tool>) completed.`，结果本身只给模型看。「If Claude is idle when the result arrives, Claude starts on it unprompted.」原来的 tool_result 不会被补写（推断，依据：文档只说结果走 notification）。

**轮询还是通知：只轮询。** task 返回后立刻发一次 `tasks/get`，之后每个间隔发一次。`pollIntervalMs` 被限制在 250 到 30000 ms 之间，缺省 2000，每次响应都会重新读取。`tasks/result`、`tasks/list`、`notifications/tasks` 都不用（§Report status, results, and questions 表格）。

**进度和取消。** 底栏显示「1 MCP task」。`/tasks` 列表里显示服务端最近一次 `statusMessage`，以及连接状态（重连中、需要登录、300 秒没联系上等）。在 `/tasks` 里按 `x`，或者让 Claude 去停，都会停止跟踪并发 `tasks/cancel`，但服务端仍可能做完。如果服务端没连上，就发不出取消，Claude Code 会直接忘掉这个任务。Esc 停不了后台任务。2.1.295 修复了「从任务面板停止长 MCP 调用后，Claude 没有收到通知」：现在停止后会告诉 Claude 不会有结果了（§Automatic backgrounding）。

**`input_required`。** 交互式会话里弹出 elicitation 对话框；拒绝或按 Esc 也算回答，由服务端决定任务是否继续。每个 key 只回答一次，每个任务最多处理 16 个 key。`elicitation/create` 只在交互式终端里处理，`roots/list` 任何地方都处理，处理不了的请求就取消任务。非交互式会话直接取消任务，不走 hooks，也不调用 `onElicitation`（§Answer a question from an MCP task）。

**失败和过期。** `tasks/get` 返回 `-32602` 时，按「未知 task」处理，继续重试最多 5 分钟，然后告诉 Claude「outcome unknown」。文档提醒，再调一次可能会把工作重复做一遍。`ttlMs` 过了也不主动丢弃任务。`failed` 时把 `error.message` 交给模型（§Status messages、表格）。

**收尾。** 文档 §Exit, clear, or resume 的表格：

| 情形 | 任务怎样 |
|---|---|
| `/clear`、`/branch`，或 `/resume` 另一会话 | 只要进程还在，结果进入**当前**对话 |
| 退出 Claude Code | 远端任务**不取消**，退出时也不发 `tasks/cancel` |
| 交互式 resume 原会话 | 服务端连上后接着跟踪；如果任务已经结束且服务端还记得，模型会拿到结果 |
| 新会话或 `--fork-session` | 不跟踪 |
| `claude -p` 一次性运行 | 没有 MCP task；运行结束后不等后台 MCP 工作，普通后台调用的结果直接丢失（headless.md §MCP work when a non-interactive run ends） |

另外，服务端改了名字或连接配置（URL、headers、timeout 等）以后，resume 不会继续跟踪旧任务，会提示「reconfigured to a different transport」。

### 2.2 claude.ai（web）

扩展矩阵在 2026-10-28 给它打了 Tasks 的勾（PR modelcontextprotocol#3459，由维护者要求 Claude 提交）。Anthropic 的博客「Bringing MCP 2026-07-28 to Claude」（2026-07-28）只说「Support is being rolled out across Claude products」，没有任何行为细节。**我找不到**描述 claude.ai 上 task 怎么阻塞、怎么展示、怎么取消的公开文档。`anthropics/claude-ai-mcp` 的 issue 里也没有相关条目。

### 2.3 VS Code / GitHub Copilot Chat（2025-11-25 实验版 Tasks）

出处是 `microsoft/vscode@4991a88ff5`。`LATEST_PROTOCOL_VERSION = "2025-11-25"`（`platform/mcp/common/modelContextProtocol.ts:43`），仓库里搜不到 `2026-07-28`。

- **逐请求要求任务。** 服务端声明了 `tasks.requests.tools.call`，并且 Tool 的 `execution.taskSupport` 是 `required` 或 `optional` 时，`tools/call` 带上 `task: {}`（`mcpServer.ts:1407-1415`）。
- **原地阻塞。** `callTool` 收到 `CreateTaskResult` 后 `await task.result`，等到终态才把普通的 `CallToolResult` 交回，聊天这一轮一直等着（`mcpServerRequestHandler.ts:518-527`）。规范 §Backwards Compatibility 说的就是这种做法。
- **轮询加通知。** 按 `pollInterval`（缺省 2000 ms）轮询 `tasks/get`；同时接收 `notifications/tasks/status`，用来更新状态（`mcpServerRequestHandler.ts:383-384, 683-700`）。`statusMessage` 作为工具调用的进度消息显示（`onStatusMessage`）。任务管理器「survives reconnections」，重连后接着轮询（`mcpServer.ts:346-347`）。
- **TTL。** 到 `ttl` 后在本地把任务标成 cancelled（「Task timed out.」）。
- **取消。** 取消聊天请求时，CancellationToken 只把本地状态设成 cancelled、拒绝 promise。客户端代码里**没有任何地方调用 `cancelTask`**（只有方法定义），所以服务端不会收到 `tasks/cancel`。这是推断，依据是对 `cancelTask(` 的全仓库搜索。
- **`input_required`。** 再发一次 `tasks/get`（注释写的是按旧规范调 `tasks/result`，以便拿到 SSE 流）。服务端在流上发 elicitation 请求，由普通的 elicitation 处理器接住（`mcpServerRequestHandler.ts:653-672, 715-722`）。
- 会话被删除时的行为：代码里看不出有专门处理（推断：任务和请求一起被放弃）。

### 2.4 GitHub Copilot CLI（2025-11-25 实验版）

changelog 1.0.41（2026-05-05）：「Add experimental MCP Tasks support: MCP tools with `taskSupport: "required"` run as non-blocking background agents trackable via `list_agents` and `read_agent`」，需要打开 experimental 模式。也就是说，它把长 MCP 调用**套进了已有的后台 agent 机制**：模型用 `read_agent` 读取，完成时有后台 agent 通知（1.0.x 的其他条目提到「Background agent completion notifications」，`read_agent` 已经在等时不再重复通知）。另外，非交互模式会等所有后台 agent 结束才退出。changelog 里没有更细的说明（取消、input_required、持久化），也找不到文档。

### 2.5 官方 TypeScript SDK：`@modelcontextprotocol/client` 2.4.0 + `@modelcontextprotocol/ext-tasks` 0.2.3

- **核心 SDK 本身不处理 task。** 2.x 只保留了 2025-11-25 的 task 类型，标为 deprecated wire vocabulary（`typescript-sdk/docs/migration/support-2026-07-28.md` §Tasks）。核心 SDK 会自动完成 MRTR 的 `input_required`（不是任务里的那种）：它调用已注册的 elicitation、sampling、roots 处理器，然后重试原请求；没开 `autoFulfill` 就抛 `UnsupportedResultType`（`packages/client/src/client/client.ts:740-770`）。
- **ext-tasks 提供一个和协议代次无关的执行对象。** `session.callTool()` 返回 `ToolExecution`：可能是立即结果，也可能是 task。返回之后由应用决定怎么等（`typescript/client/execution.md`）：
  - `settle({ onEvent })` / `result()`：在本地等到终态，`onEvent` 收到每个任务快照（status、statusMessage），可以用来画进度。
  - `cancel()`：发 `tasks/cancel`，并释放本地所有权。
  - `detach()`：释放本地所有权，远端任务继续跑。
  - `close()`：释放所有权，并**尽力取消**还没结束的任务。调用方的 signal 中止时，只停止本地等待，不取消远端任务。调用中途中止、task 却已经返回时，也会尽力 `tasks/cancel`（`session.ts:808`）。
  - `handoff(save)`：先把 task 引用存到持久存储，再 detach；存储失败时执行仍然有效，可以重试。之后在任何进程里都可以用 `session.resumeTask(reference)` 恢复，恢复后的 API 和新调用完全一样。`endpointId` 要用服务端 URL、租户等稳定标识生成（`typescript/client/input-and-recovery.md`）。
- **轮询为主。** 默认间隔 1000 ms，下限 10 ms，取各个提示值中最大的（`client/execution.ts:87-102`）。会接收服务端推来的 `notifications/tasks`（2025 版是 `notifications/tasks/status`），并转发给活动中的执行（`session.ts:906-943`）。源码里没有调用 `subscriptions/listen`（推断：不会主动订阅）。
- **input。** 每个 session 注册一个 `onInputRequest`（elicitation、sampling、roots），包负责把请求路由回对应的执行。上下文里的 `scope` 区分 `request`（MRTR）和 `task`。执行被取消、detach 或关闭时，会中止它名下正在进行的输入处理。
- **2025-11-25 兼容。** Tool 标了 `required` 但服务端没有 task 能力时直接报错；`optional` 加上调用方 `prefer` 时带上 `task` 参数（`session.ts:345-376`）。
- **接 2026-07-28 Tasks 服务端时，必须额外提供 `rawDispatch` 和 `v2RequestFraming`，否则创建 session 会抛错**（`packages/ext-tasks/README.md`）。

### 2.6 MCPJam（Inspector / 测试工具）

矩阵上打了 Tasks 的勾。`sdk/src/mcp-client-manager/task-await-driver.ts` 的头注释写明了两种模式：交互界面里返回一个 handle，让人在标签页里看；自动化（评测、CLI `tasks watch`、公开 API）用 `await` 模式驱动到终态。`await` 模式一定会结束，结局只有固定几种：`completed`、`failed`、`cancelled`、`expired`（`-32602`）、`input-required`（没人能回答时）、`timeout`、`aborted`、`unreachable`。它也遵守 `pollIntervalMs`、错误退避和 `Retry-After`。它是开发者工具，不是 agent 平台，这里只把它当作「无人值守时怎么收尾」的参考。

### 2.7 ChatGPT / Codex

- 矩阵上没有 Tasks 的勾。OpenAI 的 plugins 文档里搜不到 `tasks/get` 或 Tasks 扩展。
- 和长任务相关的有两样：
  1. 「Extended forms」：OpenAI 注册的 MCP 服务端必须用 MRTR 做 elicitation（`plugins/build/extensions.md`）。
  2. **MCP Events**：服务端在事件发生时回调 ChatGPT 的 webhook，ChatGPT「receives the event in the subscribed chat and follows the user's instructions」，可以把多个事件合并成一次 task run（`plugins/build/mcp-events.md`）。这是「外部结果推回会话并唤醒」的另一种做法，靠的是 webhook 加签名密钥，不是轮询。
- Codex 的 MCP 调用是阻塞的，`tool_timeout_sec` 默认 60 秒（`learn.chatgpt.com/docs/extend/mcp.md`）。`openai/codex` 源码里搜不到 `tasks/get`。

### 2.8 Cursor

官方文档和 changelog 都没能读取，矩阵上也没有 Tasks 的勾。论坛帖「Remote MCP calls fail after ~300s…」（2026-07-23）下，Cursor 员工 Mohit 在 2026-07-24 确认了两件事：远程 HTTP 调用在约 300 秒时被 undici 的 headers 超时切断，「There's no per-server or global timeout setting exposed today」；「Cancelling the agent turn currently rejects the call locally but doesn't abort the in-flight MCP HTTP request」。他建议服务端改用 SSE，或者「先开任务再轮询」。所以 Cursor 是原地阻塞，有硬超时，取消也不传到服务端。

## 3. 对比表

| | 支持的 Tasks | 一轮怎么等 | 结果怎么交回模型 | 轮询或通知 | 进度和取消 | `input_required` | 会话结束、失败、删除时 |
|---|---|---|---|---|---|---|---|
| **Claude Code CLI** | 2026-07-28 扩展（beta，≥2.1.304），只限主对话 | 立刻转后台（可配置为原地等）；普通调用 2 分钟后转后台 | 工具结果是 task ID；结果作为 task notification 新消息交回，空闲时自动开工 | 只轮询，250–30000 ms，缺省 2000 | `/tasks` 显示 statusMessage 和连接状态；`x` 或让 Claude 停 → `tasks/cancel`，并告诉模型没有结果 | 交互式弹 elicitation 对话框；非交互式取消任务 | 退出不取消；resume 原会话后接着跟踪；新会话或 fork 不继承；`-32602` 时重试 5 分钟后报「outcome unknown」 |
| **claude.ai web** | 矩阵上标为支持 | 找不到 | 找不到 | 找不到 | 找不到 | 找不到 | 找不到 |
| **VS Code Copilot Chat** | 2025-11-25 实验版（客户端看 `taskSupport` 逐请求要求） | 原地阻塞 | 等到终态后作为普通工具结果交回 | 轮询（缺省 2000）加 `notifications/tasks/status` | statusMessage 当进度显示；停止只在本地放弃，不发 `tasks/cancel`（推断） | 再发 `tasks/get`，elicitation 走普通处理器 | 重连后继续；TTL 到期在本地标为取消 |
| **Copilot CLI** | 2025-11-25 实验版，只限 `required` 的 Tool，需 experimental | 转成后台 agent | 后台 agent 完成通知，或 `read_agent` | 找不到 | `/tasks`、`list_agents`（推断：沿用后台 agent 的停止） | 找不到 | 非交互模式等后台 agent 全部结束才退出 |
| **官方 SDK + ext-tasks** | 两代都支持（2026 版需额外配置） | 由应用决定：`settle`、`detach`、`handoff` | 由应用决定（`ToolExecution` 结局） | 轮询为主（缺省 1000），接收推送 | `onEvent` 快照；`cancel()` 发 `tasks/cancel` | `onInputRequest` 统一路由，区分 request 和 task scope | `close()` 尽力取消；`handoff` 加 `resumeTask` 跨进程恢复 |
| **MCPJam** | 2026-07-28 | 交互模式给 handle；自动化模式驱动到终态 | — | 轮询，遵守间隔和 `Retry-After` | 有界面（没细查） | 自动化下返回 `input-required` 结局 | 结局固定几种：`expired`、`timeout`、`unreachable` 等 |
| **ChatGPT** | 不支持 | 阻塞（推断） | — | —（另有 MCP Events，webhook 推送后唤醒会话） | — | MRTR elicitation | — |
| **Codex** | 不支持 | 阻塞，默认 60 秒超时 | — | — | — | — | — |
| **Cursor** | 不支持 | 阻塞，远程调用约 300 秒硬超时 | — | — | 取消不传到服务端 | — | — |

## 4. 对 #85 各个问题的启示

### 4.1 是否像 Subagent 那样经 Inbox 和 Notification 交回？

**是，这是业界唯一成熟的做法。** Claude Code 的「工具结果先交回一个句柄，结束时一条通知进入对话，空闲时唤醒」和 Orqestra 的 Subagent 模型（ADR 0001）一一对应。Copilot CLI 更直接，把它实现成了后台 agent。原地阻塞（VS Code、Cursor）的问题，正是 ADR 0001 当初放弃 `subagent_wait` 的理由：Run 被占着，User 不能插话，进程重启就丢。

需要定的细节：

- **术语。** GLOSSARY 里 Notification 现在只指「Subagent 的结果」，Outcome 也只描述 Subagent。要么把 Notification 扩展为「后台工作（Subagent 或 MCP Task）的结果」，要么为 MCP Task 起一个新词。这需要在 #85 里用 domain-modeling 定下来。
- **先等一段再转后台？** 服务端返回 task，本身就说明它认为这件事慢，所以 Claude Code 默认立刻转后台。它把「先等 2 分钟」只用在服务端没返回 task 的普通调用上。建议 Orqestra 对 task 立刻转后台，工具结果写明「已在后台运行，结果会以通知送达」。普通长调用要不要自动转后台，是另一个问题，不必和 #85 绑在一起。
- **Subagent 里的调用。** Claude Code 只在主对话里启用 task，原因没写（推断：它的 subagent 是一次性的，结束了就没有地方接收通知）。Orqestra 的 Subagent 是有 Inbox 的子 Conversation，技术上可以接收。但「Subagent 还有 Task 没结束，算不算 running」要和「还有子 Subagent 在跑就不发 Notification」那条规则（ADR 0001 修订）一起定。

### 4.2 轮询还是等服务端通知？

**轮询。** 没有一个产品用 `subscriptions/listen`：Claude Code 明确不用，SDK 不主动订阅。订阅要求客户端长时间持有一条流，这和 Orqestra 的 Run 由 BullMQ worker 短时执行的方式不合。建议：

- 把 taskId 连同 MCP Server、Connection、Conversation 持久化（规范 SHOULD）。轮询用延迟任务调度（推断：BullMQ 的 delayed job 就够），不占 Run，也不占 worker 的长连接。
- 间隔遵守 `pollIntervalMs`，并设上下限。Claude Code 用 250 到 30000 ms，缺省 2000。
- 服务端暂时联系不上或鉴权失败，就继续重试，界面上显示原因。重试有上限，到上限就给模型一个「结果未知，别盲目重调」的结局（Claude Code 是 5 分钟后报「outcome unknown」）。
- 鉴权：每次 `tasks/get` 都要用发起这次调用的 User 的 Connection（#80 规定按用户 OAuth）。Connection 失效时，处理方式和上一条一样。Admin 删除 MCP Server 或改了配置，就不该再拿旧 taskId 去问（Claude Code 发现配置变了就不再跟踪）。
- 选库：pi-mcp 不支持 Tasks（#84）。官方 ext-tasks 的 `handoff` 加 `resumeTask` 正好对应「存进数据库，由别的进程接着跟踪」，但接 2026-07-28 时要提供 `rawDispatch` 和 `v2RequestFraming`。这个由 #87 定。

### 4.3 User 能不能在界面上取消？

能，而且应该能。参照 Claude Code：在 Conversation 里显示正在进行的 Task，带服务端最近一次 `statusMessage`（规范不允许在任务上发 progress，只能用这个字段）和连接状态，旁边一个取消按钮。取消时发 `tasks/cancel`，**立即**停止跟踪（规范允许，不必等到 `cancelled`），然后给 Agent 一个「已取消，不会有结果，服务端可能已经做了部分工作」的结局。VS Code 和 Cursor 只在本地放弃，这是反面例子：服务端不知道，工作继续烧钱。Agent 自己能不能取消（Claude Code 允许「ask Claude to」），以及 User 的取消要不要像停止 Subagent 那样等下一条 User 消息才送达，也需要一起定。

### 4.4 Run 失败、Conversation 被删除时怎么处理？

- **Run 失败。** 所有转后台的实现里，任务的寿命都和发起它的那一轮无关（Claude Code 退出都不取消）。Orqestra 的 Subagent 也比 Run 活得久。建议 Task 同样比 Run 活得久，结果照常进入 Inbox。
- **User 停止 Conversation。** 各家做法不同：Claude Code 按 Esc 停不了后台任务，退出也不取消；但 Orqestra 的 Stop 会停掉 Subagent、取消 Timer。为了一致，建议 Stop 也对 Task 发 `tasks/cancel`。这需要在 #85 里拍板。
- **删除 Conversation。** 没有一家公开说明过。按 SDK 的 `close()` 语义（尽力取消）推断：删除时对还没结束的 Task 尽力发一次 `tasks/cancel`，然后删掉记录，不等结果。
- **服务端忘了任务（`-32602`、TTL 过期）。** 当作「结局未知」交给 Agent，不当作失败去重试。本地不要按 `ttlMs` 主动丢弃任务（Claude Code 不丢；VS Code 在本地标为取消，那是 2025 版的做法）。

### 4.5 和 Timer、Wake 的关系

- **Wake。** Task 结束时，它的结果像 Subagent 的 Notification 一样进入 Inbox。Conversation 没有 Run 时就 Wake（Claude Code：「If Claude is idle … starts on it unprompted」）。被 User 停止的那种例外，要不要也「等下一条 User 消息」，见 4.3。
- **Timer。** 轮询是平台内部的调度，**不应该占用 Agent 的 Timer**。Timer 是 Agent 自己设的，每个 Conversation 只能有一个，而且只限顶层 Agent，用它轮询会和 Agent 自己的 Timer 冲突。Agent 也不需要自己去轮询（Claude Code 和 Copilot CLI 都不让模型轮询）。
- **预算。** Timer 有「上次 User 消息之后最多响几次」的限制，Subagent 有启动预算，都是为了防止平台在没人的时候一直自己唤醒自己。MCP Task 的完成也会唤醒 Agent，需要决定是否计入同一类预算，以及在 Unattended Run 里怎么算（推断：Firing 的 Conversation 里，Agent 发起 Task 后 Run 结束，Task 完成后再被唤醒，这仍然属于 Unattended Run）。

### 4.6 `input_required`（#85 没单列，但实现时躲不开）

- 规范要求按普通 elicitation 的信任模型处理，「a Task is not a higher-trust channel」。
- 现在 Orqestra 没有 elicitation 界面（MCP Apps 不在范围内）。有两种选择：
  - **最小做法（参照 Claude Code 非交互模式和 MCPJam 自动化模式）：** 只声明 `roots`（或什么都不声明）。遇到 `input_required` 就 `tasks/cancel`，告诉 Agent「服务端需要用户输入，平台不支持，任务已取消」。
  - **完整做法：** 把 elicitation 映射成一张给 User 的表单卡片。它和 Question 不同：它不结束 Run，可能在 Agent 已经去做别的事时才出现，而且答案要回给服务端而不是 Agent。所以不能直接复用 Question，需要新的术语和界面。
- 建议先用最小做法，把完整做法放进 Not yet specified。
- 注意：规范建议需要输入的 MRTR 在**创建 task 之前**同步完成（§Task Creation），所以多数 elicitation 会出现在普通调用里，而不是 task 里。这部分归 2026-07-28 核心的 MRTR 支持管，不归 Tasks。

## 5. 没找到或没核实的

- claude.ai web 的 Tasks 行为：除了矩阵上的勾，没有公开资料。
- Glean：矩阵上标了支持，但没找到它的开发者文档。
- Cursor 的官方文档和 changelog：读取被拒，只用了论坛里员工的答复。
- Copilot CLI 对 MCP task 的取消、`input_required` 和持久化：changelog 之外没有资料。
- VS Code 不发 `tasks/cancel`：依据是代码搜索，属于推断，没有实际运行验证。
