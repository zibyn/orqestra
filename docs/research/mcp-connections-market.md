# 远程 MCP / 第三方 OAuth 集成的「每用户授权」：市面产品对比

> 调研日期：2026-11-10。目标：为 orqestra 的 Connection（User 对某个 Admin 配置的 MCP Server 的授权）找参照：谁添加服务器、每用户的链接叫什么、未连接时怎么办、共享凭据还是每用户凭据、无人值守运行用谁的凭据、过期/撤销/移除、管理员可见性、每工具控制。
>
> 只采用一手来源（官方帮助中心、开发者文档、管理员文档）。Microsoft Learn 页面带 `ms.date`，下文照录；Claude、OpenAI、Notion、Slack 的帮助页大多不给确切日期（只写「本周更新」之类），记为调研日抓取。
>
> **限制**：`help.openai.com` 对抓取返回 403，ChatGPT 部分的说法来自搜索引擎对这些官方页面的摘录（标出了页面 URL），没有逐页通读。Cursor 没找到关于每用户 OAuth / 管理员控制的一手文档，跳过。标「推断」的内容没有直接出处。

---

## 0. 速览

| 产品 | 谁添加服务器 | 每用户链接的叫法 | 未连接时 | 共享 vs 每用户凭据 | 无人值守运行 | 每工具控制 |
|---|---|---|---|---|---|---|
| Claude（Team/Enterprise） | Owner（Enterprise 还有带 Libraries 管理权限的自定义角色） | connector；用户点 **Connect** | 认证模式「Sign in now / Sign in when needed / No sign in」 | OAuth=每用户；固定 header（API key）=全组织共享；Enterprise 另有「组织级授权」（IdP 管理 / Claude 签发） | 文档未说明 | 每类/每个工具 Always allow / Needs approval / Blocked，组织级，用户不能放宽 |
| ChatGPT（Business/Enterprise） | Admin/Owner 发布（Enterprise 可用 RBAC 让成员创建） | app / plugin 的 **connected account** | 文档未说明 inline 行为 | 普通聊天=每用户；Workspace Agent 每个 app 选 **End-user account** 或 **Agent-owned account** | 团队任务：无人值守运行**不能完成新的登录**；Slack 里的 agent 必须用共享连接 | Admin 的 Action control（新 action 默认关闭）、审批前冻结工具快照；用户侧权限级别 |
| Copilot Studio | Maker（建 agent 的人）在 agent 的 Tools 里加 | **connection**；用户在 **Manage your connections** 页管理 | 暂停并显示 **Connection Required** 卡片，连上后**自动重试**该工具调用 | 每个工具选 **End user** 或 **Maker-provided**；管理员可按环境禁用 maker 凭据 | 禁用 maker 凭据后，定时/自主触发**直接失败** | 加工具时挑选；数据策略（DLP）管连接器 |
| Gemini Enterprise | Admin（Discovery Engine Editor）建 Custom MCP Server data store | 数据源旁的 **Enable Actions** / 授权 | 用户在聊天框数据源旁点 Enable Actions 并授权后才能用 | 每用户 OAuth（scopes 在用户授权时请求） | 定时 agent 用**创建者的凭据**，每 14 天过期需手动刷新 | 默认**没有任何工具启用**，Admin 逐个 Enable actions |
| Notion Custom Agents | 有 Full Access / Can Edit 的用户；Admin 先开开关并可限制为审批名单 | MCP **connection**（每个 agent 一份） | — | **认证者本人的凭据**，绑定在 agent 上，所有触发共用 | 支持定时触发；连接被移除则定时运行可能失败 | 每工具开关；写工具默认 **Always ask** |
| Slackbot（MCP client） | Admin 审批含 `mcp:connect` 的 app，逐个 MCP server 允许/拒绝 | 在 Slackbot > Apps 点 **Connect** | 文档未说明 | 每用户 | — | 用户每 app/每工具 Always allow / Needs approval / Blocked / Custom |
| VS Code | 用户（企业可用策略限制为私有 registry） | Accounts 菜单 **Manage Trusted MCP Servers** | — | 每用户；预览中的 enterprise-managed auth（XAA） | — | 用户在工具选择器里开关 |

---

## 1. Claude.ai（connectors / custom connectors）

来源：
- [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)（「Updated over a week ago」）
- [Use connectors to extend Claude's capabilities](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)（「Updated this week」）
- [Auto-connect your organization's apps to Claude](https://support.claude.com/en/articles/15537633-authorize-mcp-connectors-for-your-entire-organization)（「Updated this week」）
- [Set up the Microsoft 365 connector](https://support.claude.com/en/articles/12542951-set-up-the-microsoft-365-connector)

1. **谁添加、配什么**：Team 只有 Owner / Primary Owner；Enterprise 还包括拥有「Manage access to Libraries」的自定义角色；Pro/Max 用户自己加。路径 Organization settings > Connectors > Add > Custom > Web。配置项：显示名、服务器 URL、认证模式（**Sign in now / Sign in when needed / No sign in**）、OAuth 客户端身份（Claude 公布的身份〔推荐〕、自动注册〔DCR〕、或自带 OAuth client）、可选的固定请求头（API key / bearer token，加密存储）。页面没有写 scopes 字段；用户授权时「review what permissions the MCP server is requesting」。修改配置要删了重加。
2. **叫法与位置**：connector。Admin 在组织里加好后，「users individually connect to and enable that connector」：成员在 Customize > Connectors 找到它点 **Connect**。每个对话里再通过「+」> Connectors 的开关启用。
3. **未连接时**：文档只给出认证模式「Sign in when needed」（推断：在首次用到时于对话中要求登录），以及 Claude「can bring it into a conversation on its own when it fits」；没有写中途授权后是否续跑当轮。连接器多时有「Auto / On demand」工具加载模式（≥10 个推荐 On demand）。
4. **共享 vs 每用户**：OAuth 是每用户；固定 header 是共享——「everyone who uses it gets the same access」，建议用权限受限的凭据。Enterprise 还有**组织级授权**：「authorize a connector once for your entire organization, and your team inherits access automatically on first login」，两种身份源：IdP 管理（访问跟随 IdP 组/角色）或 Claude 签发（beta，按邮箱给成员签发登录；「checks organization membership only, not SSO, MFA」）。可限定适用角色和授予的 scopes。所以 Admin 按服务器可以在「每用户 OAuth / 共享固定凭据 / 组织代授权的每用户身份」之间选。
5. **无人值守**：Microsoft 365 文档写到「when a scheduled task you set up needs it」会访问 M365，即定时任务用**设置者本人**的连接；refresh token 默认 90 天不活动过期。过期时定时任务如何报错，没找到文档。
6. **过期/断开/撤销/移除**：认证失败时建议在 Customize > Connectors 断开重连；可在第三方服务的安全设置里撤销。Owner 可在组织设置中移除连接器。组织级授权下：IdP 停用用户即撤销；Claude 签发模式下移出组织后「access already granted at a service lasts until it expires」。
7. **管理员可见性**：组织级授权的 Configuration 页显示「Applied roles」「Scopes」；**没有**找到「谁已连接」的逐用户列表或替用户撤销的入口。
8. **每工具**：Owner 可把每类（如 read-only、write/delete）或每个工具设为 **Always allow / Needs approval / Blocked**，Team/Enterprise 上组织级生效、用户不能放宽；「restrictions only narrow access」。用户在对话里也能关掉单个工具。

## 2. ChatGPT（apps / plugins / developer mode / workspace agents）

来源（均为 help.openai.com / developers.openai.com；help 页面 403，内容来自搜索摘录）：
- [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [Admin controls, security, and compliance for plugins and apps](https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps)
- [Connecting and managing app accounts in ChatGPT](https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt)
- [Managing app permissions in ChatGPT](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt)
- [ChatGPT Workspace Agents for Enterprise and Business](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business)（搜索显示约 13 天前更新）
- [Creating and managing team tasks in ChatGPT](https://help.openai.com/en/articles/20001540-creating-and-managing-team-tasks-in-chatgpt)（约 14 天前）
- [Scheduled tasks in ChatGPT](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)

1. **谁添加、配什么**：Business 上只有 Admin/Owner 能为自定义 MCP 创建并发布；Enterprise/Edu 可用 RBAC 把「Create plugins with MCPs」权限给选定成员（Enterprise 默认关），但只有 Admin/Owner 能发布到工作区。配置：公网 HTTPS MCP 端点（或 Secure MCP Tunnel）+ 认证。发布后 Admin 用 RBAC 决定谁能访问每个 app。审批时 ChatGPT 冻结工具与输入的**快照**，开发者后续改动要 Admin 重新审批发布；自定义 MCP 的新 action 默认关闭，变更以 diff 显示。当前流程已不需要先开 Developer Mode（旧 release notes 仍这么写）。
2. **叫法与位置**：UI 已从 Apps 迁到 **Plugins**（2026-07-09 迁移，既有连接不受影响）；每个 app 下有「Connected accounts」，可「Connect another account」（多账户）、Reconnect、Disconnect（Settings > Plugins > app > ••• > Disconnect）。安装 plugin 不能跳过账户授权。
3. **未连接时**：搜到的文档未描述对话中途的 inline 连接卡片。
4. **共享 vs 每用户**：普通聊天是每用户。**Workspace Agent 每个 app 连接可选**：「End-user account — each person running the agent authenticates with their own account」或「Agent-owned account — the agent uses a shared connection, so people running the agent do not need to authenticate during the run」；建议共享连接用服务账户。Slack 里的 agent 必须对所有 app 用共享连接；用个人账户做共享连接会让别人通过它触发操作。
5. **无人值守**：团队任务：「Complete any required app sign-in before the task runs. An unattended run can't complete a new app sign-in for you.」团队任务用团队服务账户 + 工作区连接。定时任务排查：看是否暂停/待审批，确认 app 账户仍已连接且授权。定时运行在发消息或改外部数据的动作上可暂停等审批。
6. **过期/断开/撤销/移除**：Reconnect 按钮；断开最后一个账户可能卸载相关 plugin，卸载 plugin 会断开所有关联账户；改权限级别不等于撤销。大版本更新后用户可能需要重连。
7. **管理员可见性**：没找到逐用户连接列表或替用户撤销的文档。
8. **每工具**：Admin 端「Role access（谁能用）/ Actions（能做什么）/ Permissions（何时先问）」三分；Google/Microsoft app 写操作默认禁用，需在 Manage actions 打开；发布后仍可 Action control。用户端权限级别如「Allow read actions」（读不问、写先问）、「Allow low-risk actions」。

## 3. Microsoft Copilot Studio（MCP + connections）

来源：
- [Connect your agent to an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)（ms.date 2026-10-30）
- [Configure user authentication for tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-enduser-authentication)（ms.date 2026-10-14）
- [Set up your connections when an agent asks](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/end-user-connections)（ms.date 2026-10-16）
- [Control maker-provided credentials for authentication](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-no-maker-authentication)（ms.date 2025-09-01，updated_at 2026-10-07）
- [Use connectors in Copilot Studio agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-connectors)（ms.date 2026-08-18）

1. **谁添加、配什么**：Maker 在 agent 的 Tools > Add a tool > New tool > Model Context Protocol（向导）里填 Server name、**Server description**（编排器据此决定何时调用）、Server URL（只支持 Streamable HTTP）、认证：None / API key（header 或 query；**由 agent 用户提供 key**）/ OAuth 2.0。OAuth 三种：**Dynamic discovery**（DCR + 发现）、**Dynamic**（DCR，手填 Authorization URL、Token URL）、**Manual**（Client ID、Client secret、Authorization URL、Token URL、Refresh URL、可选 Scopes；生成 callback URL 去 IdP 注册）。最后「Create a new connection」或选已有的，Add to agent。MCP 走 Power Platform 连接器，所以**数据策略（DLP）**也管 MCP 服务器及其工具。也可通过 Agent 365 在 M365 Admin Center 注册/审批 BYO MCP server。
2. **叫法与位置**：**connection**。用户侧有 **Manage your connections** 页（列出 agent 中「Each end user signs in with their own account」的工具/流/模型），状态 **Connected / Not connected / Expired / Stale**（agent 改动后需复核），对应动作 Manage / Connect / Renew / Review。**连接按 agent × channel 保存**，同一 agent 换频道要再连。
3. **未连接时**：「Copilot Studio checks whether the user has a valid connection… Otherwise, the agent displays a connection card」。新体验里 agent **暂停**并显示 **Connection Required** 卡片（Set up connection / Retry / Deny）；「After the connection succeeds, the window closes and the agent retries the tool automatically」；Deny 取消该动作并告知用户。自建聊天界面需自己实现弹窗与续跑。
4. **共享 vs 每用户**：每个工具选 **User authentication（End user）** 或 **Agent author authentication（Maker-provided）**，默认用户凭据。Maker 凭据还可通过 Power Apps 共享连接给他人。管理员在 Power Platform admin center 按环境/环境组「Control maker credential options」：允许 End-user、Maker-provided 或两者；默认两者都允许，禁用 maker 后立即对所有 agent 生效。
5. **无人值守**：「agents triggered by scheduled or autonomous events, or that attempt to run in the background, fail due to missing credentials. All agent triggers must involve an active user.」——即每用户凭据下自主运行**不可能**，只能靠 maker 凭据。
6. **过期/断开/撤销/移除**：「Copilot Studio doesn't store any credentials. Agents prompt users to reconnect when an access token expires or is revoked」。用户可在 Manage your connections 里 Disconnect（不可撤销，下次需要时再问）。agent 变更后连接变 Stale。
7. **管理员可见性**：管理员靠环境级策略与 DLP；本次没找到「谁连了某 MCP」的专门视图（Power Platform 的 connections 属于各自所有者）。
8. **每工具**：加 MCP 时可挑选工具；数据策略可按连接器管控。

## 4. Google Gemini Enterprise（原 Agentspace）

来源：
- [Set up your custom MCP server data store](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)
- [Manage actions](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/manage-actions)
- [Schedule chat agent executions](https://docs.cloud.google.com/gemini/enterprise/docs/agent-designer/schedule-agent)
- [Gemini Enterprise release notes](https://docs.cloud.google.com/gemini/enterprise/docs/release-notes)
（页面未显示日期）

1. **谁添加、配什么**：Admin（需 Discovery Engine Editor）在 Apps > Connected Data Stores 建「Custom MCP Server」data store：MCP Server URL、Authorization URL（+ 参数如 `access_type=offline`）、Token URL、Client ID/Secret（Admin 先在 IdP 注册 Gemini Enterprise 为 OAuth client，redirect `https://vertexaisearch.cloud.google.com/oauth-redirect`）、Scopes（「Gemini Enterprise requests these scopes during user authorization」）、PKCE、HTTP Basic。也可「No authentication」。
2. **叫法与位置**：数据源 / actions；用户在聊天框的数据源列表旁点 **Enable Actions** 并完成授权。
3. **未连接时**：用户「must click this button and complete authorization before they can use the assistant actions」——未授权的 actions 不可用。
4. **共享 vs 每用户**：每用户 OAuth（连接器「Preserves the user's OAuth token intact」传给服务器）。Admin 可在 Actions 页 Re-authenticate（用另一套凭据）。没找到按服务器切换成共享凭据的选项。
5. **无人值守**：「Chat agent schedules operate using your user credentials… these credentials expire every **14 days**. You must manually refresh」。定时运行涉及他人的动作暂停等审批；agent 转移所有者会禁用其定时/事件触发。建议加 `offline_access` 以便刷新。
6/7. 撤销、移除、谁已连接：文档未覆盖。
8. **每工具**：「By default, no tools or actions from your custom MCP servers are enabled」；Admin Reload custom actions 后逐个 Enable（一次最多 100）。

## 5. Notion（Custom Agents 的 MCP connections）

来源：[MCP connections for Notion Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)、[Connect AI tools to your workspace with Notion MCP](https://www.notion.com/help/notion-mcp)（无日期）

- Admin 先开「Enable custom MCP servers」，并可「Limit which connections members can install」：Approved & recommended / Approved only，可按服务器 URL 加入审批名单。
- 有 Full Access / Can Edit 的用户给 agent 加连接；连接「uses the credentials of the person who authenticated it」，**绑定在单个 agent 上**，「not shared across agents」；只有认证者能改工具设置。即：Notion 的 agent 连接是**创建者凭据、所有运行者共用**。
- 支持所有触发方式含定时；连接被移除后定时运行可能失败。
- 每工具开关；读工具适合「Run automatically」，写工具默认 **Always ask**；「Always allow」整服务器免确认。Disconnect 后 agent 不再能访问。
- 反向（Notion 作为 MCP server）：Enterprise Admin 可限定「Approved MCP clients only」，工具按每个用户自己的 Notion 权限执行。

## 6. Slack（Slackbot 作为 MCP client）

来源：[Use Slackbot to work with other apps from Slack](https://slack.com/help/articles/52462803708819-Use-Slackbot-to-work-with-other-apps-from-Slack)、[Admin approval for apps with MCP servers](https://docs.slack.dev/ai/slackbot-mcp-client/admin-approval/)（无日期）

- MCP server 随 Slack app 声明（`mcp:connect` scope）。开启审批时进 Admin 的 Requests 队列，可批准 / 带限制批准 / 拒绝；「Each MCP server can be individually allowed or denied」；新增其他域名的 MCP server 需重新审批；Enterprise org 始终需审批。「Only after admin approval will the MCP server appear in Slackbot for users to connect」；app 的访问范围自动套用到其 MCP server。
- 用户：「connect your account」——Slackbot > Apps > **Connect**；Disconnect 同处。
- 每工具：默认 Always allow，可改为 Needs approval / Blocked / Custom（逐工具），按 Read-only / Write 分组。
- 未连接时的 inline 行为、管理员看谁已连接：未覆盖。

## 7. VS Code（参考：开发者客户端）

来源：[MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)、[Secure AI-assisted development](https://code.visualstudio.com/docs/agents/run/security)、[VS Code 1.106](https://code.visualstudio.com/updates/v1_106)、[VS Code 1.123](https://code.visualstudio.com/updates/v1_123)

- 用户自己加服务器；企业用 `ChatMCP` 策略（`registryOnly` / `off`）和 `McpGalleryServiceUrl` 限定私有 registry。
- OAuth 先试 DCR；1.123 起可在 `oauth` 里直接写预注册 client ID。
- 用户在 Accounts 菜单的 **Manage Trusted MCP Servers** 看哪些服务器能用该账户。
- 1.123 预览「enterprise-managed auth」（跨应用授权 XAA）：策略下发 IdP，服务器用 `"enterpriseManaged": true` 选择加入——与 Claude 的「IdP 管理的组织级授权」同一方向。

---

## 8. 对 orqestra 最相关的规律

1. **「Admin 加服务器、User 各自连」是共识**。Claude、ChatGPT、Gemini、Slack 都把「组织启用」和「个人授权」分成两步：Admin 启用不等于用户获得访问，用户还要自己点 Connect。（[Claude](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)、[Slack](https://docs.slack.dev/ai/slackbot-mcp-client/admin-approval/)、[Gemini](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server)）
2. **凭据模式按服务器（或按工具）可选，且管理员能封顶**。Copilot Studio：每个工具 End user / Maker-provided，管理员可按环境禁掉 Maker；ChatGPT Workspace Agent：每个 app End-user / Agent-owned；Claude：OAuth（每用户）/ 固定 header（共享）。共享凭据的风险被反复点名（越权、个人账户被他人驱动）。（[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-no-maker-authentication)、[ChatGPT](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business)）
3. **无人值守运行 = 要么共享凭据，要么调度者本人事先连好；运行中无法补登录**。Copilot Studio 明说每用户凭据下定时/自主触发会失败；ChatGPT 团队任务「can't complete a new app sign-in」；Gemini 定时用创建者凭据且 14 天过期；Notion 直接用认证者凭据。对 Scheduled Task：用任务所有者的 Connection，缺失/过期时失败并提示，而不是挂起等待。（[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-no-maker-authentication)、[ChatGPT team tasks](https://help.openai.com/en/articles/20001540-creating-and-managing-team-tasks-in-chatgpt)、[Gemini](https://docs.cloud.google.com/gemini/enterprise/docs/agent-designer/schedule-agent)）
4. **交互对话中缺连接：Copilot Studio 是唯一把「暂停→连接卡片→自动重试该工具调用」写清楚的**，含 Deny 取消。Gemini 则是先授权否则 action 不可用；Claude 的「Sign in when needed」暗示按需登录但未写续跑；其他未文档化。（[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-enduser-authentication)、[连接卡片](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/end-user-connections)）
5. **连接有显式状态**：Copilot Studio 的 Connected / Not connected / Expired / Stale（agent 改了要复核）、ChatGPT 的 Reconnect 按钮。过期一律走「提示用户重连」，靠 refresh token 延续（Gemini、Copilot Studio 都强调 refresh / `offline_access`）。（[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/end-user-connections)）
6. **每工具控制以「允许 / 需审批 / 禁止」三档为主，按读/写分组，管理员设上限、用户只能收紧**。Claude、Slack 用 Always allow / Needs approval / Blocked；Notion 写工具默认 Always ask；Gemini 与 ChatGPT 的自定义 MCP 新工具/动作默认关闭，ChatGPT 还冻结审批时的工具快照。（[Claude](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)、[Slack](https://slack.com/help/articles/52462803708819-Use-Slackbot-to-work-with-other-apps-from-Slack)、[ChatGPT](https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps)）
7. **分歧：连接挂在哪一层**。Claude/ChatGPT/Slack/Gemini 是「用户 × 服务器」，一次连接所有对话通用；Copilot Studio 是「用户 × agent × channel」；Notion 是「agent」（创建者凭据）。orqestra 的 Connection 若定为「User × MCP Server」，与多数一致；Subagent 自然沿用发起 User 的 Connection。（[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/end-user-connections)、[Notion](https://www.notion.com/help/mcp-connections-for-custom-agents)）
8. **管理员看不到「谁连了」是普遍空白**。没有一家文档提供逐用户连接列表或替某个用户撤销；撤销靠 IdP 停用（Claude 组织级授权）、移出组织、或用户自己 Disconnect。新兴方向是 IdP 托管授权（Claude 的 IdP-managed / Claude-issued、VS Code 的 XAA），让管理员通过 IdP 一处授权一处撤销。（[Claude](https://support.claude.com/en/articles/15537633-authorize-mcp-connectors-for-your-entire-organization)、[VS Code 1.123](https://code.visualstudio.com/updates/v1_123)）

### 未确认的点
- Claude、ChatGPT 在对话中途缺连接时是否 inline 提示并续跑当轮：未找到文档。
- 管理员移除服务器后已有连接/令牌如何处理：各家都未明确（Claude 仅说可移除；Slack 说换域名需重审批）。
- ChatGPT 帮助页因 403 未全文通读。
