# 工具调用审批（执行前要用户点头）：个人 Agent 产品怎么决定「什么时候问」

> 调研日期：2026-11-10。目标：Orqestra 要定「工具调用审批」——Agent 在某次 Tool 调用真正执行前，先停下来让 User 同意。用户倾向**按动作的敏感程度**决定要不要问，而不是让 Admin 配一张「每个工具 allow / approve / deny」的矩阵；参照对象是面向个人的 Agent 产品。
>
> 每家关心的问题：**谁决定要问**（模型判断 / 分类器 / 工具注解 / Admin 配置 / 用户设置）、**哪些算敏感**、**用户看到什么、能做什么**、**一次同意管多久**、**等待时怎么办**、**无人值守 / 定时 / 后台时怎么办**。
>
> 每用户 OAuth 连接（Connection）那部分已在 `docs/research/mcp-connections-market.md` 调研过，不重复；其中 Claude 连接器的「Always allow / Needs approval / Blocked」组织级矩阵、Slackbot 的每工具权限、Notion 写工具默认 Always ask 在那里有出处。
>
> 只采用一手来源（官方帮助中心、开发者文档、System Card、官方博客）。帮助中心多数页面不给确切日期，记为调研日抓取。
>
> **限制**：`help.openai.com`、`openai.com` 对抓取返回 403。ChatGPT 部分以两份可下载的 System Card PDF（cdn.openai.com）为主；帮助中心的说法只来自搜索引擎对官方页面的摘录，标为「弱」。ChatGPT agent 本身据搜索摘录已下线、由 ChatGPT Work 接替（弱）。Copilot Studio 的「人工审批工具调用」只有路线图条目和微软韩国团队的 GitHub Pages 文章，没有 Learn 文档（弱）。Manus 没找到「重大操作前确认」的一手说法。Grok 指的是 xAI 的 **Grok Bot**（docs.x.ai）；早期的 Grok Tasks（定时提示词）没找到任何确认机制的文档。标「推断」的内容没有直接出处。

---

## 0. 速览

| 产品 | 谁决定要问 | 敏感类别（文档原例） | 用户的选项 | 同意的作用范围 | 等待 / 无人值守 |
|---|---|---|---|---|---|
| ChatGPT agent / Operator | **模型自己判断**（训练出来的行为）+ 按站点开 Watch Mode | 购买、发邮件、删日历事件、改文档权限、高风险通信、金融交易；转账/股票**直接拒绝** | 看当前状态后继续或纠正；登录时 **Take over** | 单次 | 敏感站点上用户离开就**自动暂停**；定时任务遇到审批会暂停（弱） |
| Claude in Chrome / Cowork | 用户选的**权限模式** + **每步安全分类器** + 固定「必问」清单 | 改权限设置、授予授权、向网站输入敏感信息、**永久删除**；购买/开户/交易**禁止** | Allow this action / Always allow actions on this site / Decline | 单次或**按站点永久**（可在设置里撤销）；必问清单不受「永久」影响 | 暂停等待，文档未写超时；文档建议别把发消息、购买放进定时任务 |
| Grok Bot（xAI） | **Auto Review**（模型审查每个工具调用）+ 用户自写自然语言规则（Ask first / Allow automatically） | 发送、对外分享；不可撤销的操作卡片带「This can't be undone」 | Allow once / Always allow（存成规则）/ Not now | 单次或存成规则（最多 20 条） | 聊天发起的**不限时**；后台/例程的卡片 **30 分钟过期**、不执行；例程发的邮件**只存草稿** |
| Gemini Agent | 产品规定「总要确认」的类别 + 用户权限偏好 | 发送通信、购买、提交网页表单、编辑共享文档；登录/密码/支付要**用户接手** | 确认 / 拒绝（拒绝后**不换路子**）/ 随时接手浏览器 | 偏好可放宽，但「非常敏感的操作**每次**都要确认」 | 登录步骤暂停到用户接手；离线时定时任务可能**来不及阻止** |
| Microsoft Copilot（消费者 Tasks / Browse） | 产品规定的类别 | 金钱交易、提交个人信息、**涉及他人**（邮件/消息）、**改账户**（删文件、改云存储）、健康/政府/安全类 | 批准 / 自己完成 / 随时中断或接手 | 定时任务可在**创建时**预先批准 | 「暂停并要你输入」；定时任务「在设置时要批准，以便将来无人值守」 |
| Windows 智能体（Copilot Actions） | 用户的每 Agent 文件夹权限 + 「敏感操作」时请求 | 敏感数据（如信用卡）只在用户授权的上下文 | Allow Always / Ask every time / Never allow | 永久或每次 | 在独立 Windows 会话里后台跑 |
| Copilot Studio（企业） | **Maker 按工具勾选** | — | 确认；（路线图）Approve / Approve for session / Deny | 单次或本会话 | 文档未说明自主触发时怎么办 |
| Perplexity Comet | 模型识别「重要任务」 | 登录某站点、完成购物车购买 | 允许一次 / 停止 / 自己操作 | 单次 | — |
| OpenClaw（自托管） | 配置：security（deny/allowlist/full）× ask（off/on-miss/always） | 主机命令执行 | Allow Once / Always Allow Here | 单次或绑定到**确切命令+目录**；自动化下绑定到 agent+job+操作 | 无界面可问或超时 → `askFallback`，默认 **deny** |
| MCP 规范 / ChatGPT 开发者模式 | **工具注解** `readOnlyHint` | 没标只读的一律算写 | 确认；可「记住」 | **本对话**，新对话重新问 | — |

---

## 1. ChatGPT agent / Operator（OpenAI）

来源：
- [ChatGPT Agent System Card](https://cdn.openai.com/pdf/839e66fc-602c-48bf-81d3-b21eacc3459d/chatgpt_agent_system_card.pdf)（2025-07）
- [Operator System Card](https://cdn.openai.com/operator_system_card.pdf)（2025-01）
- 帮助中心 [ChatGPT agent](https://help.openai.com/en/articles/11752874)、[Scheduled tasks / ChatGPT Work](https://help.openai.com/en/articles/10291617)（仅搜索摘录，**弱**）

1. **谁决定**：模型。「we trained ChatGPT agent to ask the user for confirmations before finalizing actions that affect the state of the world (e.g., before completing a purchase or sending an email)」。没有用户可调的开关、没有按工具的配置——是训练出来的判断，用评测衡量。
2. **效果怎么量**：Operator 在 20 类风险动作、607 个任务上确认召回率 92%；ChatGPT agent 91%（「a large fraction of the failures are false negatives」），但**关键动作**召回率：改权限 100%、发高风险通信 99.9%、完成金融交易 100%。Operator 卡说确认把模型失误的风险降了约 90%。
3. **敏感类别**：Operator 的策略明确列「conducting financial transactions, sending emails, deleting calendar events」；基线实验里不可逆的失误是发错收件人、批量删标签、提醒日期写错、点错外卖。
4. **分三档**：要确认（上面那些）；**主动拒绝**（「banking transactions」「selling or purchasing stocks」「financial account transfers」、受管制商品、赌博）；其余直接做。
5. **用户看到什么**：确认是对话里的一句话，例：「I've selected all the emails in the GitHub Notifications label, and I'm about to delete them. Should I proceed?」用户「can review the current state and indicate whether it should proceed」，也可以纠正、改方向。
6. **Watch Mode**：在敏感上下文（「logged into an email or banking account」）里用可视浏览器时，对**这次轨迹的剩余部分**开启，「automatically pausing execution when the user becomes inactive or navigates away」，用户回到页面后继续。也就是说：按**上下文**升级监督，而不是按工具。
7. **接手（takeover）**：需要登录时暂停，请用户接管虚拟浏览器（帮助中心摘录，弱）。
8. **无人值守**：帮助中心摘录说定时任务里「Actions that require approval may pause the task」，任务卡住时去 Scheduled 看是否有待批准项（**弱**）。没找到超时的说法。

## 2. ChatGPT 开发者模式 / MCP 规范：靠工具注解

来源：
- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)（抓取 404，仅搜索摘录，**弱**）
- [MCP schema 2025-11-25 `ToolAnnotations`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)、[MCP Tools 规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/tools.mdx)

1. ChatGPT：「Write actions by default require confirmation」；「We respect the readOnlyHint tool annotation. Tools without this hint are treated as write actions」。可选「记住」批准，只对**本对话**有效，「New conversations will prompt for confirmation again」（弱）。
2. MCP 规范：`readOnlyHint` 默认 false，`destructiveHint` 默认 true（只在非只读时有意义），`openWorldHint` 默认 true。原话：「all properties in ToolAnnotations are **hints**… Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers.」规范另说应当「be a human in the loop with the ability to deny tool invocations」并对操作给确认提示（SHOULD）。
3. 含义：注解是现成的「敏感度」信号，但**由 MCP Server 自报**，只有 Admin 信任的服务器才能拿来决定放行；缺省值是保守的（不标就当有破坏性）。

## 3. Claude in Chrome / Claude Cowork（Anthropic）

来源：
- [Claude in Chrome permissions guide](https://support.claude.com/en/articles/12902446)
- [Use Cowork safely](https://support.claude.com/en/articles/13364135)（「Updated over a week ago」）
- [Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Piloting Claude for Chrome](https://claude.com/blog/claude-for-chrome)（2025-08-25）
- 连接器每工具权限见 `mcp-connections-market.md` §1.8

1. **权限模式（用户在输入框旁选）**：
   - **Manually approve**（原名 Ask before acting）：「Claude pauses and asks for approval before each action」；经典侧栏先给计划让你批。
   - **Automatically approve**（Cowork 侧栏默认）：每个动作执行前由安全审查过一遍（「checking for data exfiltration or prompt injection」），不安全的拦下，需要时暂停问你；如果反复被拦，「switches back to asking for your permission for each step」。
   - **Skip all approvals**（原名 Act without asking）：不停、不查。
2. **任何模式都必问**：改权限设置、授予授权、向网站输入可能敏感的信息、永久删除（清空回收站、删邮件/文件/消息）。Cowork：「Claude always asks before permanently deleting files, in any mode」。
3. **任何模式都禁止**：购买或金融交易、开账户、处理信用卡/证件、从不可信来源下载、投资建议、交易、改系统文件、**执行邮件或网页里的指令**。
4. **用户选项与范围**：「Allow this action」（只这一次，下个动作再问）、「Always allow actions on this site」（按站点长期，但下载、敏感信息、授权仍会问）、「Decline」（Claude 可换方法或跳过）。已批准的站点在设置里列出，可撤销、看历史。
5. **等待**：暂停，弹「New permissions required」；文档没写超时。
6. **Admin**：Team/Enterprise 可设站点白名单/黑名单（黑名单「regardless of user permissions」）；连接器工具可组织级设 Always allow / Needs approval / Blocked，用户不能放宽。
7. **无人值守**：定时任务云端跑，电脑关机也跑；新建任务时有一个「approval mode」字段，文档没列选项。安全页直接劝：「Don't schedule tasks that access sensitive files, send messages on your behalf, make purchases」。第三方指南和大量用户 issue 说：Needs approval 的连接器工具只在 Manual 模式下暂停定时任务、Auto 模式由 Claude 判断；且「Always allow」在定时运行里经常不生效、运行卡在审批上（**弱**，均为第三方/用户报告）。

## 4. Grok Bot（xAI）

来源：[Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)

1. **谁决定**：**Auto Review**，默认开，在 Bot 运行命令、调用已连接的 app、使用电脑之前审查每个动作，结论是放行或出审批卡。内置安全检查始终生效，不受用户规则影响。Admin 可强制开启。
2. **用户规则**：自然语言写的「Ask first」和「Allow automatically」各最多 20 条、每条 ≤1000 字。Allow 规则只在审查**没别的理由拦**时生效；两者都命中时「Ask first wins」。
3. **卡片**：显示操作和输入，不可逆的带「This can't be undone」。按钮：「Allow once」（不存规则）、「Always allow」（存成 Allow 规则，显示「Saved to Custom Rules」）、「Not now」/「Skip」。拒绝后 Bot 跳过该动作，**直到用户下一条消息前不再重试或再问**。
4. **邮件**：聊天里要求的邮件批准后发送；**例程、收到的消息等后台工作产生的邮件只存草稿**，等用户按发送。转发和审查读不全附件的邮件总要确认。
5. **等待**：聊天发起的卡片**不限时**；后台（例程、来信触发）的卡片 **30 分钟后过期**，显示「Expired」，动作不执行，用户可点「Always allow next time」或让 Bot 重试。用户发新消息会关闭该聊天里未决的卡片。
6. **多人**：共享 Bot 里只有请求者能批自己的请求；群聊里只有被回复的那个人能批，且**不提供 Always allow**。
7. **敏感输入**：登录走 Vault → 密码管理器 → Secure Form，填的值不给模型看；聊天里别发密码，用遮罩的密钥卡片。存在 Vault 的卡结账时**不再单独审批**——想每笔都批就别存卡。SSO、passkey、验证码、银行卡验证等用 **Take over**，完成后点「I'm done」。
8. **本地电脑**：默认「Ask every time」，可选「Always allow」「Never allow」；Admin 上限更严时以 Admin 为准。

## 5. Gemini Agent（Google）

来源：[Use Gemini Agent for multi-step tasks in Gemini Apps](https://support.google.com/gemini/answer/16596215)

1. **规定必问**：「Gemini is designed to always ask for your review and confirmation before it completes certain actions」，例：发送通信、购买、提交网页表单；编辑共享文档要先审阅确认计划中的修改；浏览网页的任务先确认。
2. **用户偏好有上限**：「Even if you update your permission preferences, very sensitive actions require your permission each time.」
3. **拒绝的语义**：「If you deny an action in a task thread, Gemini stops and doesn't try another way to complete it.」（对比 Claude：Decline 后可能换方法。）停止浏览后 Gemini 可能尝试继续，也可能放弃任务。
4. **接手**：登录等步骤「the task pauses until you take over」；不要在对话里输入登录信息、支付信息，要接手浏览器在网页上自己填。用密码管理器里的登录信息是单独一项权限。
5. **无人值守**：远程浏览器关掉设备也继续跑；「If a schedule runs when you are offline, you may not be able to stop Gemini from completing an unintended action.」——即定时任务不会因为你不在而更保守（推断：确认类动作仍会等，文档建议「Monitor your task regularly for any input Gemini may need」）。同时最多 15 个任务。

## 6. Microsoft Copilot

### 6.1 消费者 Copilot Tasks / Browse with Copilot

来源：[Using Copilot Tasks](https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-tasks)、[Browse with Copilot](https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot)（原 Copilot Actions in Edge）

1. **需要批准的类别**（Tasks 原文分组）：「Monetary transactions」（购买、付款）；「Submitting personal information」到外部网站；「Actions involving other people」（发邮件、消息）；「Account‑altering actions」（删文件、改云存储）；「Sensitive actions」（健康相关提交、政府文件、安全相关改动）。Browse：买东西、订座、发邮件、删日历事件时「ask for your attention and supervision」；网站看起来和任务无关时也会请你批准该站点。
2. **用户能做**：批准或自己完成；随时点中断按钮停止、随时接手；高风险网站上会要求你盯着或接手。
3. **定时任务**：「Copilot may ask for required approvals during setup so the task can run unattended in the future.」——**在创建时预先批准**，运行时不再问。文档没说运行中遇到未预批的审批怎么办，也没说超时。
4. 不存密码、信用卡号；不能读自动填充、已存密码和钱包。

### 6.2 Windows 智能体功能（Copilot Actions on Windows）

来源：[Experimental agentic features](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)

- 原则：「Agents must be able to explicitly request a user's authorization or decision where necessary」；用户可审阅并批准计划；权限「granular, specific and time bound」。
- 每个 Agent 对已知文件夹三档：**Allow Always / Ask every time / Never allow**，默认要你同意。
- 敏感信息（如信用卡）只在用户授权的上下文可用。Agent 用独立账户、在独立 Windows 会话里后台跑，行为与用户自己的可区分。

### 6.3 Copilot Studio / Microsoft 365 Copilot 里的 Agent（企业）

来源：[Add tools to custom agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-tools-custom-agent)（ms.date 2026-10-01）；路线图 [RM570434](https://mc.merill.net/message/RM570434) 与[微软韩国团队文章](https://microsoft.github.io/mwkorea/copilot/CopilotStudioHumanApproval/)（**弱**）

1. 每个工具有「**Ask the end user before running**」，默认 **No**，由建 Agent 的 Maker 勾；可写一段描述在问用户时展示。——这是本文里唯一纯按工具、由配置者决定的方案。
2. 路线图「require human approval for tool calls」：按 Agent、按工具开关；调用暂停、在 Teams / M365 Copilot 里内联显示审批，选项 **Approve / Approve for session / Deny**；计划 2026-09 GA（弱，未在 Learn 文档里核实）。自主触发时怎么办没写。

## 7. Perplexity Comet

来源：[Comet Assistant puts you in control](https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control)（2025-11-14）

- 助手识别到重要任务时「will pause and ask for permission before proceeding」，例：「logging in to a certain site or completing a purchase from your shopping cart」。
- 用户能看到它点哪、滚哪，侧栏看逐步推理；有停止和补充指示的按钮；可以只允许「browse on your behalf once」，或自己浏览。
- 发邮件前是否确认只有二手说法（**弱**）。

## 8. Manus

来源：[Cloud Browser](https://manus.im/help/cloud-browser)

- 遇到验证码、短信验证等时用 **Take Over** 临时交还浏览器，可设置「需要接手时怎么通知你」；不存密码。
- 「下单、发邮件前把决定权交还用户」只出现在搜索摘录里，抓取的页面没有这句（**弱**）。

## 9. OpenClaw（自托管个人 Agent）

来源：[Exec approvals](https://docs.openclaw.ai/tools/exec-approvals)

1. 两个维度：`security` = deny / allowlist / full，`ask` = off / on-miss（白名单不命中才问）/ always；新版 `tools.exec.mode` 还有 ask、auto（白名单命中直接跑，不命中的由判定给出 allow/deny/ask）。审批默认值只能**收紧**配置，不能放宽。
2. 「Allow Once」只放这一次；「Always Allow Here」存一条白名单，绑定**确切 argv 和工作目录**，换地方就算不命中。自动化运行里 Always allow 变成绑定到 agent + job + 操作的长期授权。MCP 工具授权绑定到一个 agent、一个服务器、一个工具，参数不限。
3. 审批出现在 Control UI、macOS/iOS/Android 应用、声明了审批能力的 API 客户端；聊天渠道可 `/approve`，但**聊天渠道永远收不到自动化的审批**。
4. **没有界面可问或超时**：走 `askFallback`，默认 **deny**；网关自动化没有审批面时**立即拒绝**，运行错误里说明怎么修。

---

## 对 Orqestra 的启示

1. **「敏感度」由平台/模型定，不由 Admin 逐工具填表。** 面向个人的产品（ChatGPT agent、Gemini、Copilot Tasks、Comet、Claude in Chrome、Grok Bot）都是一份**固定的敏感动作类别**加上**模型或分类器逐次判断**：类别高度一致——花钱/金融交易、以用户名义对外发送（邮件、消息、发布）、删除（尤其永久删除）、改权限/授权、向外提交个人或敏感信息、登录。按工具配置只出现在企业搭建器（Copilot Studio 的 Maker 勾选、Claude 连接器的组织级矩阵）。Orqestra 可行的形态：模型在调用时给出「这是不是有后果的动作」的判断（ChatGPT 的确认是训练行为，Claude/Grok 是调用前的审查），以 MCP 的 `readOnlyHint`/`destructiveHint` 作为可信服务器的先验（缺省按「会写、有破坏」处理），Admin 只保留粗粒度的「禁用」而不是三态矩阵。
2. **三档而不是两档：直接做 / 先问 / 不做。** 每家都有一类「无论用户怎么设都不做」的动作（转账、买股票、开户、执行网页/邮件里的指令），以及一类「无论用户怎么放宽都每次问」的动作（Gemini 的「very sensitive actions… each time」，Claude 的永久删除和授权，Grok 的内置检查）。用户的放宽只作用在中间那档。
3. **同意的范围要窄：默认单次，最多到「本对话」或「这个站点/这条规则」。** ChatGPT 开发者模式「记住」只管本对话；Copilot Studio 路线图是「Approve for session」；Claude 的「Always allow」按站点且仍保留必问清单；OpenClaw 绑定到确切命令和目录。没有一家让一次点击变成全局永久放行最高敏感动作。拒绝的语义要写清：Gemini 拒绝后不换路子，Grok 拒绝后直到下条消息不再问。
4. **无人值守不能挂起等人：要么事先批，要么降级成草稿/失败。** Grok Bot：后台卡片 30 分钟过期、动作不执行，例程发的邮件只存草稿；OpenClaw：没有审批面就立即拒绝（`askFallback` 默认 deny）；Copilot Tasks：在创建定时任务时预先批准；Claude 直接劝别把发消息、购买放进定时任务，而它「运行中卡在审批上」恰是用户投诉最多的地方（弱）。对 Orqestra 的 Unattended Run / Firing：需要确认的动作不应让 Run 无限挂起——可以「改为产出草稿/提案交给 User」或「这次调用失败、Agent 继续」，再用 Notification 告诉 User；交互式 Run 则可像 Question 一样不限时等待。
5. **审批就是对话里的一次暂停，带上要执行的内容。** 各家的确认都内联在对话里，展示「要做什么、参数是什么、能否撤销」（Grok 的「This can't be undone」、ChatGPT 的「I'm about to delete them. Should I proceed?」），可以批准、拒绝、纠正方向，涉及凭据/支付时让用户**接手**而不是把密码交给模型。在 Orqestra 里它和 Question 很像（都是等 User），但不同于 Question 的是它针对一次具体调用、可以过期，而且只有发起请求的那个 User 能批（Grok 共享 Bot / 群聊的规则）。
