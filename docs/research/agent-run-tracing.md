# Agent 运行追踪与用户数据保护：其他平台怎么做

> 调研日期：2026-11-10。问题来自 [#90](https://github.com/zibyn/orqestra/issues/90)，服务于 [#86 Run 追踪的记录内容与保留](https://github.com/zibyn/orqestra/issues/86)。已定的前提：Usage（每次 Model 请求的 token 与成本）永久保留、User 可见；Run 追踪只给 Admin，不含消息正文和 Memory。
>
> 只采用一手来源（规范仓库、官方文档）。WebFetch 抓到的是页面当时的内容；Microsoft Learn 页面照录 `ms.date`。
>
> **限制**：OpenAI 平台 Traces 的保留期和删除方式在官方文档里没有找到（只有社区帖，未采用）；Vertex AI Agent Engine 的追踪页没写默认值和保留期，保留期取自 Cloud Trace 的通用配额页；Dify 的节点级记录有无单独清理没有找到说明。标「推断」的内容没有直接出处。

---

## 0. 速览

| 产品 | 片段粒度 | 与用量/成本的关系 | 默认保留 | 会话/数据删除后 | 内容默认采集？开关 | 错误分类 |
|---|---|---|---|---|---|---|
| OpenTelemetry GenAI 约定 | `invoke_agent` / `invoke_workflow`、推理（chat）、`execute_tool`、embeddings、retrieval、memory 操作；子 Agent 转交是 `execute_tool` 的细化 | token 作为推理 span 的属性（`gen_ai.usage.*`），另有 token 指标；不含成本 | 不规定（交给后端） | 不规定；外存内容「不规定保留策略」 | **默认不采**（`NO_CONTENT`），`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` 打开；工具参数/结果同属此开关 | `error.type` 为低基数类别（provider 错误码、异常类名、`timeout`、`_OTHER`）；MCP 工具 `isError` 记 `tool_error`；`exception.message` 标「可能含敏感信息」 |
| OpenAI Agents SDK / 平台 Traces | trace = 一次工作流；span：agent、generation、function（工具）、guardrail、handoff、语音 | Agent span 上有 token 用量；用量可能在 turn 结束后才到 | 文档未写 | 文档未写删除方式 | **默认采**（`trace_include_sensitive_data=True`），可关；可整体关闭追踪；ZDR 组织不能用追踪 | span 记录 status 与工具错误；无公开分类表 |
| Claude Managed Agents | 会话事件流：model request 起止、工具调用/结果、压缩、线程（子 Agent）状态、错误；OTel 导出：turn → model_request / tool / compaction | 每次 `span.model_request_end` 带 `model_usage`；会话与线程有累计 usage 与 list_cost；组织 Usage/Cost 报表**另存**，可按 agent/session 分组 | 会话历史保留到删除会话为止 | 会话历史随会话删除；上传文件、memory store 不随会话删除；组织用量报表独立 | 控制台查看器是全文（仅 Developer/Admin）；OTel 导出**默认 Metadata only**，可选 Full content | `session.error` 带类型化 `error` 与 `retry_status`；`session.status_rescheduled` 表示瞬时错误自动重试 |
| Claude Code（OTel 监控） | 事件：user_prompt、api_request、api_error、tool_result 等；spans | `api_request` 事件带 token 和成本 | 交给后端 | — | **默认脱敏**：提示、回复、工具参数、工具内容、原始 API body 各有开关，全部默认关 | `tool_result` 默认带 `error_type`（如 `Error:ENOENT`、`ShellError`），**完整错误信息要 `OTEL_LOG_TOOL_DETAILS=1`** |
| LangSmith | run（`llm`、`tool`、`chain`、`retriever`、`embedding`、`prompt`、`parser`）组成 trace，trace 再按 thread 分组 | 每个 run 带 `prompt_tokens`/`completion_tokens`/`total_cost` | base 14 天 / extended 180 天，按工作区设置；评估器、自动化规则会把 trace 升级为 extended | 到期后输入输出一天内删除，**部分元数据为用量与成本统计无限期保留**；可按 trace ID 或 metadata 删除（异步，约 6 小时内落定） | 默认采；`LANGSMITH_HIDE_INPUTS/OUTPUTS`、`hide_metadata`、正则/函数 anonymizer（客户端） | run 上一个 `error` 字符串（原文） |
| Langfuse | trace 下的 observation：span、generation、event、agent、tool、chain、retriever、embedding、evaluator、guardrail | usage/cost 记在 generation/embedding observation 上，**按写入时的价格算，改价不回溯** | 自托管默认无限期；Pro/Enterprise 可按项目设天数（≥3 天），夜间任务删除 | 可按 trace 删（异步，约 15 分钟内），连带 observation 与 score；保留策略不删审计日志和数据集 | 默认采；客户端 `mask` 函数（作用于 input/output/metadata），或 OTel Collector 处理器 | `level`（DEBUG/DEFAULT/WARNING/ERROR）+ 自由文本 `statusMessage` |
| Vertex AI Agent Engine | 走 OTel GenAI 约定导出到 Cloud Trace | — | Cloud Trace span 30 天 | — | 遥测开关与内容开关**分开**：`GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY` 不含提示与回复；`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 另开，文档要求先取得终端用户同意 | 沿用 OTel |
| Copilot Studio | 会话 transcript（含主题触发等元数据）；Application Insights 事件与节点执行事件 | 分析页另算 | Copilot Studio 存储 28 天自动删；Dataverse transcript 默认 30 天，可改 | Admin 可关掉 transcript 保存（关后最多还会存 24 小时） | Application Insights 中「Log conversation details」（消息文本、用户名，以及 OTel span 里的工具参数与结果）和「Log sensitive Activity properties」**是可选项** | 有 exceptions 视图；无公开分类表 |
| Dify | 会话 / workflow run，打开后逐节点 trace（输入、输出、token、耗时、失败位置） | token 与延迟记在 run/回答上 | 自托管默认**无限期**；可开清理，默认留 30 天 | 删除会话或清理日志**不删已上传文件** | 全文记录；文档提醒「日志包含完整用户对话」 | 节点状态；无公开分类表 |

---

## 1. OpenTelemetry GenAI 语义约定

来源（规范已迁到独立仓库，opentelemetry.io 的旧页只剩迁移说明）：
- [gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)（含「Capturing instructions, inputs, and outputs」）
- [gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [execute-tool.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/execute-tool.md)
- [client-inference.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md)
- [gen-ai-exceptions.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-exceptions.md)
- [mcp.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)

1. **粒度**：Agent 层有 `create_agent`、`invoke_agent`（LLM 通过工具调用驱动控制流）和 `invoke_workflow`（应用定义控制流）；下面是每次推理（`gen_ai.client.inference`）、每次工具执行（span 名 `execute_tool {gen_ai.tool.name}`）、embeddings、retrieval、memory 操作（`search_memory`、`create_memory` 等）。转交给另一个 Agent 的工具调用用 `execute_tool` 的「agent as a tool」细化，且「SHOULD NOT report additional spans」。压缩以推理 span 上的 `gen_ai.conversation.compacted` 正向标记表示。
2. **用量**：token 是推理 span 的属性（`gen_ai.usage.input_tokens`/`output_tokens`/cache/reasoning 等，应报计费口径的数），另有同名指标。约定里没有成本字段。
3. **内容**：原文——「Model instructions, user messages, and model outputs are considered sensitive … OpenTelemetry instrumentations SHOULD NOT capture them by default, but SHOULD provide an option for users to opt in.」受同一开关管的属性包括 `gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.system_instructions`、**`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result`**、检索查询文本、prompt 变量、**`gen_ai.memory.query.text`、`gen_ai.memory.records`**。环境变量 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`，取值 `NO_CONTENT`（默认）/`SPAN_ONLY`/`EVENT_ONLY`/`SPAN_AND_EVENT`，无法识别的值按 `NO_CONTENT`。工具定义（schema）不算内容，不受开关管。
4. **生产推荐**：三种模式——默认不记；记在 span 属性上（适合「pre-production」或存储本身合规时）；**存到外部存储、span 上只记引用**（`*_ref` URI），「recommended in production … Using external storage enables separate access controls」。约定明确「does not prescribe … retention policy, or access mechanism」。
5. **错误分类**：`error.type`「SHOULD match the error code returned by the Generative AI provider or the client library, the canonical name of exception that occurred, or another low-cardinality error identifier」，兜底值 `_OTHER`；MCP 工具结果 `isError: true` 时记 `tool_error`，JSON-RPC 错误记其错误码。异常事件里的 `exception.message` 标注「This attribute may contain sensitive information」，`exception.type` 与 message 二者有一即可。
6. **会话 ID**：`gen_ai.conversation.id` 只在框架本身有会话标识时填，不要用新 UUID 或 trace ID 冒充。

## 2. OpenAI Agents SDK 与平台 Traces

来源：
- [Agents SDK (Python) — Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Agents API — Tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing)
- [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data)

1. **粒度**：trace 是「a single end-to-end operation of a "workflow"」，有 `group_id` 串起同一会话的多个 trace；默认 span 包括整个 Runner 运行、每次 agent 运行、每次 LLM generation、每次 function 工具调用、guardrail、handoff、语音转写/合成。托管 Agents API 的 trace 是「the steps within one turn」，三类 span：agent（含子 agent，带 token 用量、耗时、结果状态）、generation、tool（含 MCP，带调用细节、结果和错误）。
2. **用量**：在 agent span 上；「A blank value or `null` means the count is unknown」「Usage can arrive after the turn ends」。
3. **内容**：**默认记**——「By default, `trace_include_sensitive_data` is `True`」；设为 False 时 generation 与 function span 去掉输入输出，也可用 `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA` 设默认。追踪可全局（`OPENAI_AGENTS_DISABLE_TRACING=1`）或按次关闭。「Tracing is unavailable for organizations that use OpenAI's APIs under a Zero Data Retention (ZDR) policy.」
4. **保留与删除**：两份官方页都没写 trace 保留期和删除方式（数据控制页只写了 Responses 应用状态默认 30 天、滥用监控日志最长 30 天）。
5. **可见性**：控制台 Logs → Agents，按项目；API 导出需要组织开启 trace export，且 key 有 `api.traces.read` 或 `api.agents.read`。

## 3. Claude Managed Agents 与 Claude 平台 OpenTelemetry

来源：
- [Inspect sessions and track usage](https://platform.claude.com/docs/en/managed-agents/session-observability)
- [Review and monitor agent sessions](https://platform.claude.com/docs/en/managed-agents/secure-deployment-monitoring)
- [Managed Agents reference — Event types](https://platform.claude.com/docs/en/managed-agents/reference)
- [OpenTelemetry tracing for the Claude API](https://platform.claude.com/docs/en/manage-claude/opentelemetry)

1. **粒度**：持久化事件里有 span 事件 `span.model_request_start`/`span.model_request_end`（后者带 `model_usage`）；`agent.tool_use`/`agent.mcp_tool_use` 与结果；`agent.thread_context_compacted`（压缩）；多 Agent 的线程事件 `session.thread_created`、`session.thread_status_running/idle/rescheduled/terminated`；`session.status_idle` 带 `stop_reason`。OTel 导出：Sessions API 请求一个 span，每个 agent turn 一个 `anthropic.session.turn`，turn 下每次 model request、每次 API 执行的工具、每次压缩各一个 span。
2. **用量**：每次 model request 的 token 在事件和 span 上；会话与每个线程有累计 `usage`（token、`list_cost`、`active_seconds`）；组织层面的 Usage/Cost 页面和 Usage and Cost Analytics API 是**另一份**记录，可按 `agent_id`/`session_id` 分组。文档特别说明导出的 span「aren't guaranteed to be a complete record of your API usage」（尽力投递、可被采样掉），要准确计量请用用量 API——即追踪与计量分开，计量不依赖追踪。
3. **保留与删除**：「Session history: Kept until you delete the session」；归档保留历史；删除前要留就自己用 events API 拷走；会话产生的文件随会话删除；**上传的文件、memory store、vault 不随会话删除**。Managed Agents 不支持 ZDR。
4. **内容与可见性**：Console 的会话查看器是全文（transcript、工具输入与结果），「only accessible to Developers and Admins」。OTel 导出每个目标有内容模式：**Metadata only（默认）**——「identifiers, timing, status, token counts, and text that you choose, such as the names and descriptions of your agents and tools and the names of your MCP servers」；Full content 才含提示与回复（工具参数在 `gen_ai.tool.call.arguments`）。有 HIPAA/FERPA/K-12 限制的组织强制只导元数据。
5. **错误分类**：`session.error`「Includes a typed `error` object with a `retry_status`」；`session.status_rescheduled` = 瞬时错误自动重试中；`session.status_terminated` = 不可恢复错误或归档。工具调用被策略拒绝/暂停记在 `evaluated_permission` 上。Inspector 的 Tools 页按工具汇总「call counts, failures, and median duration」。

### Claude Code 的 OTel 监控（对「工具参数与错误原文」最直接的参照）

来源：[Claude Code — Monitoring](https://code.claude.com/docs/en/monitoring-usage)

- 内容开关全部**默认关**：`OTEL_LOG_USER_PROMPTS`（提示，「Redacted by default」）、`OTEL_LOG_ASSISTANT_RESPONSES`、`OTEL_LOG_TOOL_DETAILS`（工具参数，如 Bash 命令、MCP 名、工具输入）、`OTEL_LOG_TOOL_CONTENT`（工具输出）、`OTEL_LOG_RAW_API_BODIES`（整段 API body，「include the entire conversation history」）。「Spans redact user prompt text, tool input details, and tool content by default.」
- `tool_result` 事件**默认**带 `tool_name`、`tool_use_id`、`success`、`duration_ms`、`error_type`（「Error category string … such as `"Error:ENOENT"` or `"ShellError"`」）；**`error`（完整错误信息）只在 `OTEL_LOG_TOOL_DETAILS=1` 时才有**。即：错误类别默认记，错误原文与工具参数同级、默认不记。
- `api_error` 事件带 `error`（错误信息）、`status_code`、`model`、`duration_ms`、`attempt`、`request_id`；这里错误信息没有被开关管——模型服务商返回的错误一般不含用户内容（推断）。

## 4. LangSmith

来源：
- [Observability concepts](https://docs.langchain.com/langsmith/observability-concepts)
- [Run (span) data format](https://docs.langchain.com/langsmith/run-data-format)
- [Administration overview — data retention](https://docs.langchain.com/langsmith/administration-overview)
- [Mask inputs and outputs](https://docs.langchain.com/langsmith/mask-inputs-outputs)
- [Data purging for compliance](https://docs.langchain.com/langsmith/data-purging-compliance)

1. **粒度**：run「represents a single unit of work」，`run_type` ∈ `chain`/`llm`/`embedding`/`prompt`/`tool`/`retriever`/`parser`；trace 是一次操作的 run 集合（上限 25,000 个 run）；thread 用 `thread_id` 元数据串起多轮，「Each turn … becomes its own trace」。
2. **用量**：每个 run 带 `prompt_tokens`、`completion_tokens`、`total_cost`——追踪与成本同一份记录。
3. **保留**：base 14 天、extended 180 天（2026-09-14 起 SaaS 上限 180 天，此前是 400 天）；工作区级设置；online evaluator、automation rule 默认把命中的 trace 升级为 extended。到期后「traces are no longer accessible」，输入输出一天内从内部系统删除，**「Some trace metadata may be kept indefinitely for analytics and billing」**；加入数据集的输入输出不随之删除。
4. **删除**：`POST /api/v1/runs/delete`，按 trace ID（每次 ≤1000）或按 metadata 键值（全工作区、任一匹配即删）；「not instant」「Most deletes are hardened within 6 hours」；连带删除 feedback、聚合与统计。
5. **内容**：默认全记；`LANGSMITH_HIDE_INPUTS`/`HIDE_OUTPUTS`/`HIDE_METADATA` 整体隐藏，或传函数；`create_anonymizer` 用正则或函数替换（默认深入 10 层嵌套）；函数级 `process_inputs`/`process_outputs`。全是客户端处理。文档建议真正不能留痕的场景用「conditional tracing」而不是脱敏。
6. **错误**：run 上一个 `error` 字符串「Error message if the run encountered an error」，无分类。

## 5. Langfuse

来源：
- [Observation types](https://langfuse.com/docs/observability/features/observation-types)
- [Log levels](https://langfuse.com/docs/observability/features/log-levels)
- [Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [Data retention](https://langfuse.com/docs/data-retention)
- [Data deletion](https://langfuse.com/docs/administration/data-deletion)
- [Masking](https://langfuse.com/docs/observability/features/masking)

1. **粒度**：trace 下的 observation：`span`、`generation`、`event`、`agent`、`tool`、`chain`、`retriever`、`embedding`、`evaluator`、`guardrail`。
2. **用量**：usage 与 cost 记在 generation/embedding observation 上；cost 可写入也可按模型价格表推算，写入的优先；「Generations already stored keep the cost calculated at ingestion time」——与本仓库 Usage「按当时 Catalog 价格」同一思路。
3. **保留**：「On self-hosted instances, data is stored indefinitely by default」；Cloud 各档只限制可查看窗口（30 天/90 天/3 年）不删除；按项目设保留天数（最少 3 天，Pro/Enterprise 或自托管企业版），夜间任务删 trace、observation、score、media；**不删审计日志和数据集**。
4. **删除**：UI 单条/批量/按筛选；API `DELETE /api/public/traces/{id}` 或批量 ID；「trace data is deleted from our system within 15 minutes」；连带删除 score 与 observation；不删数据集里的同一份个人数据。
5. **内容**：默认全记；SDK 的 `mask` 函数在发送前处理每个 observation 的 input/output/metadata；或在 OTel Collector 里用 redaction 处理器（「should run inside an appropriate trust boundary」）。没有服务端脱敏。
6. **错误**：`level` ∈ DEBUG/DEFAULT/WARNING/ERROR，配自由文本 `statusMessage`。

## 6. Vertex AI Agent Engine（Google Cloud）

来源：
- [Trace an agent](https://docs.cloud.google.com/agent-builder/agent-engine/manage/tracing)
- [Cloud Trace quotas and limits](https://docs.cloud.google.com/trace/docs/quotas)

- 两个开关分开：`GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY`「enables the agent traces, logs, and metrics」但不含提示与回复；`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`「enables the logging of input prompts, output responses, and user IDs」，文档要求先有终端用户同意和数据处理政策。页面没写默认值（示例里都是显式设置的）。
- 导出到 Cloud Trace；`_Trace` bucket 里的 span 保留 30 天。
- span 格式标为实验性。

## 7. Microsoft Copilot Studio

来源：
- [Control how transcripts are retained and accessed](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-transcript-controls)（ms.date 2026-08-27）
- [Agent-level telemetry with Application Insights](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-bot-framework-composer-capture-telemetry)（ms.date 2026-07-28）

- **两份记录**：transcript（对话 + 元数据，如起止时间、触发的主题）存 Dataverse；会话信息另在 Copilot Studio 存储中「for up to 28 days … automatically deleted」。Dataverse transcript 默认 30 天，可改。
- **Admin 控制**：按环境（或环境组，组规则优先）开关「makers 能否看/下载 transcript」与「是否保存到 Dataverse」；关掉保存后最多还会写 24 小时。查看 transcript 需要 Admin 授予的 Bot Transcript Viewer 角色，Environment maker 默认没有。
- **运维遥测**（Application Insights）：基本日志与内容分级——「Log conversation details」（用户 ID、用户名、消息文本；**开 OTel 时还管 span 里的工具输入参数与输出结果**）、「Log sensitive Activity properties」、「Node execution events」都是可选项。Admin 可用数据策略整体禁止该遥测。
- 内置监控视图：会话数、延迟、异常、工具使用、主题。

## 8. Dify

来源：[Logs（自托管）](https://docs.dify.ai/en/self-host/use-dify/monitor/logs)

- 会话列表和 workflow run 列表；打开后看每个回答的 token 与延迟、原始 prompt、Agent 工具迭代、逐节点 trace（「shows where a run failed or slowed down」）。
- 「Logs are retained indefinitely by default」；`WORKFLOW_LOG_CLEANUP_ENABLED` + `WORKFLOW_LOG_RETENTION_DAYS`（默认 30）清理 run 日志，`ENABLE_CLEAN_MESSAGES` + `SANDBOX_EXPIRED_RECORDS_RETENTION_DAYS` 清理会话消息，每日定时任务执行。
- 「Logs contain complete user conversations and may include sensitive information」；「Deleting conversations or cleaning up old logs does not erase the files uploaded in them」。
- 运维日志与用户会话是同一份数据、同一套权限，没有内容开关——是本项目要避免的形态。

---

## 9. 本仓库现状（2026-11-10，main @ 4e299bf）

没有 Run 表、没有 Usage 表，也没有任何追踪记录。Run 的结构、耗时和错误零散在下面这些地方：

| 记录 | 位置 | 记了什么 | 缺什么 / 风险 |
|---|---|---|---|
| Conversation 状态 | `packages/db/src/schema.ts` `conversation.status`、`jobId`、`stoppedJobId` | `idle`/`running`/`failed`，只有最新一次 | 没有历史、没有原因、没有开始/结束时间 |
| 每步的模型回复 | `message.message`（jsonb，pi 的 `AssistantMessage` 原样） | 含 `usage`（input/output/cacheRead/cacheWrite/cost）、`stopReason`、`timestamp`、model | 是消息正文，Admin 不该看；**失败的回复不保存**（`apps/worker/src/runtime/index.ts` 的 `message_end` 处理：`stopReason === "error"` 不存），所以失败那次请求的 token 和错误都丢；随 Conversation 级联删除 |
| 工具结果 | `message`（`toolResult`，含 `isError`） | 工具输出原文 | 同上：正文，无耗时 |
| Run 失败原因 | `apps/worker/src/runtime/index.ts`：`throw new Error(answer.errorMessage ?? "The reply failed")`；`packages/conversations/src/serve.ts` 的 worker `failed` 处理：`console.error(\`job ${id} failed\`, err)` | 错误原文进 stdout；BullMQ（pg 后端，`bullmq` schema）以 `removeOnFail: 1000` 保留最近 1000 个失败 job，含失败原因（推断：BullMQ 的 `failedReason`/stacktrace） | 无分类；原文可能带 provider 返回的内容；保留按条数不按时间，且不随 Conversation 删除 |
| Subagent 结果 | `subagent.outcome`、`subagent.result` | `queued/running/completed/partial/failed/stopped`；失败时 result 是 `[The subagent failed, or the worker running it crashed: ${error.message}]` | 错误原文写进了 User 和父 Agent 都能看到的结果里 |
| Firing | `firing.outcome`、`firing.reason` | 结局 + **低基数原因码**（`previous_running`、`agent_unavailable`、`model_disabled`） | 这是仓库里唯一已经「错误分类」的地方，可作为模式 |
| 压缩 | `compaction.tokensBefore`、`createdAt` | 压缩前 token 数、时间 | 压缩那次 Model 请求的用量与耗时没记 |
| 标题生成失败 | `console.error("title generation failed", error)` | stdout | — |
| 步数/时长上限 | `limits.unattendedMaxSteps`、`unattendedMaxDuration` | 上限配置 | 实际用了几步、多久没记 |

GLOSSARY 相关词：**Run**（产出一个 Turn 回复的工作；可停止、失败后可重试；Subagent 各有自己的 Run）、**Turn**、**Usage**（每次 Model 请求一条，含 Turn 的步骤、压缩、标题；失败、停止、被重试撤回的也算；比 Conversation 活得久，永久保留；User 看自己的，Admin 看全部）、**Subagent**、**Background Call**（启动它占 Subagent 预算；结束以 Notification 送回）、**Unattended Run**（受 Admin 设的步数与时长上限）、**Memory**（只有 User 能看，Admin 也不行）。

---

## 10. 对 #86 各问题的启示

### 问题 1：粒度——每次模型调用、每次 Tool 调用，还是两者都要？

**两者都要，而且各家都在这两层之上还有一层「运行」**。OTel、OpenAI、Claude、LangSmith、Langfuse 无一例外：一个根（invoke_agent / trace / turn）下面挂模型请求和工具调用两类片段，子 Agent 作为嵌套（OTel 的 agent-as-tool、Claude 的线程、OpenAI 的子 agent span）。对 Orqestra 的映射：

- 一条 **Run** 记录（Conversation、Agent、开始/结束、结局 completed/partial/failed/stopped、失败类别、步数、是否 Unattended）；
- 其下每次 **Model 请求**（含压缩、标题——与 Usage 的口径一致）和每次 **Tool 调用**（Tool 名、MCP Server、开始/耗时、成功/失败类别）各一条片段；
- Subagent 与 Background Call 用「父片段 → 子 Run」的引用表示，不重复记。Claude 的 Inspector 按工具汇总「调用次数、失败数、中位耗时」正是 Admin 排查最常用的视图，需要工具级片段才能算出来。
- 排队时间（入队到被 worker 拿到）、Inbox 投递、Timer 等「运行节点」只有 Claude 的状态事件（running/idle/rescheduled）算是有；可作为 Run 上的时间戳而不是单独片段，避免过度设计。

### 问题 2：和 Usage 共用一份记录吗？

**分开存、互相引用**更符合 Orqestra 已定的前提。理由：

- 两者保留期和可见性不同：Usage 永久、User 可见；追踪仅 Admin、应有期限。LangSmith 把 token/cost 放在 run 上，结果到期删 trace 时只能「为计费保留部分元数据」——这等于事后再拆一次。
- Claude 明说导出的 span「aren't guaranteed to be a complete record of your API usage」，计量另走 Usage/Cost API；即计量要求「每次请求必有一条」，追踪可以尽力而为。Orqestra 的 Usage 定义正是「每次请求都算，失败的也算」。
- 做法：Model 请求片段带 Usage 行的 ID（或 Usage 行带 Run/片段 ID），追踪视图通过引用显示 token 与成本，不自己存一份。Langfuse 的「按写入时价格算、改价不回溯」已经被 Usage 采纳。
- 现状提醒：现在 usage 只在已保存的 `AssistantMessage` jsonb 里，失败回复不存，所以 Usage 与追踪都需要在 `message_end`（包括 error）时单独写，而不是从消息里取。

### 问题 3：保留多久？

各家默认差别很大：LangSmith 14 天（可升 180 天）、Cloud Trace 30 天、Copilot Studio 28/30 天、Dify 清理默认 30 天；Langfuse 自托管、Dify 自托管、Claude 会话默认无限期（但它们存的是全文、和会话同权限）。**专门给运维看的追踪，主流默认在 14–30 天**，并由 Admin 可调（LangSmith 工作区级、Langfuse 项目级、Copilot Studio 环境级）。建议：默认 30 天，Admin 可改；按时间定期清理（Langfuse/Dify 都用每日/夜间任务），替换现在 BullMQ 按「最近 1000 条」保留失败 job 的做法。

### 问题 4：Conversation 被删除之后，追踪还留不留？

各家做法：Claude 会话历史随会话删除，但组织 Usage/Cost 记录独立保留；LangSmith 到期删 trace 后仍为计费保留部分元数据；Langfuse 删 trace 连带删 observation/score，但不删审计日志与数据集；Dify 删会话不删文件。共同点是**含内容的部分随会话走，计量与审计类的低敏元数据可以留**。

对 Orqestra：如果追踪如 #86 所设只含结构、耗时、类别化错误，不含正文和 Memory，那么它和 Usage 一样属于「低敏元数据」，可以在 Conversation 删除后保留到自身期限，只把指向 Conversation 的引用置空（像 `firing.conversationId` 的 `onDelete: "set null"`）。前提是问题 5 做到位——只要追踪里会混进用户原文，就必须随 Conversation 级联删除（Copilot Studio、Dify 的 transcript 即如此）。保留下来时不要再记 Conversation 标题（标题是 Agent 根据正文生成的）。

### 问题 5：Tool 参数和错误信息可能带用户数据，怎么脱敏？

各家的共同答案不是「脱敏」，而是**默认不记、按类别记**：

- **Tool 参数与结果**：OTel 把 `gen_ai.tool.call.arguments`/`result` 和提示、回复放在同一个默认关闭的内容开关下；Claude 平台 OTel 默认 Metadata only；Claude Code 的 `OTEL_LOG_TOOL_DETAILS` 默认关；Copilot Studio 的工具参数与结果受「Log conversation details」这个可选项管。也就是说**主流把 Tool 参数视同消息正文**。Orqestra 不提供内容开关（Admin 不应能看到正文），直接不记参数和结果，只记 Tool 名、所属 MCP Server、结果大小或是否截断这类结构信息。
- **错误**：分两层。①**类别**默认记：OTel `error.type`（低基数，provider 错误码 / 异常类名 / `timeout` / `_OTHER`；MCP 的 `tool_error`）、Claude Code `error_type`（`Error:ENOENT`、`ShellError`）、Claude `session.error` 的类型化 error + `retry_status`。②**原文**不默认记：Claude Code 的完整 `error` 与工具参数同开关；OTel 的 `exception.message` 标「may contain sensitive information」。建议 Orqestra 为 Run 失败、Model 请求失败、Tool 失败各定义一份封闭的类别枚举（例如 provider 鉴权失败/限流/超时/上下文过长/服务端 5xx；Tool 不可用/连接需重连/超时/服务返回错误/Background Call 丢失等），并附上 HTTP 状态码或 JSON-RPC 错误码这类数字——仓库里 `firing.reason` 已经是这种写法。
- **模型服务商的错误原文**：Claude Code 的 `api_error` 不加开关地记 `error` 文本，可推断服务商错误一般被视为非用户内容；但 provider 错误有时会回显请求片段（推断），保守做法是只记状态码 + 类别 + provider 的 request id（排查时去服务商那边查），原文只进 worker 日志。
- **LangSmith/Langfuse 式的正则 anonymizer**：两家都只在客户端、靠调用方自写规则，文档本身承认有性能损耗、不保证完整（LangSmith 建议真正敏感的场景直接不追踪）。不适合作为 Orqestra 的主要防线。
- **现有泄漏点**（与追踪无关但同类）：`subagent.result` 把 `error.message` 原文写进结果；worker `console.error` 与 BullMQ 失败 job 保存错误原文。定类别时可一并收敛。
