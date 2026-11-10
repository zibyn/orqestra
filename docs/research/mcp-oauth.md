# pi-mcp 1.4.0 的 OAuth 能力与 MCP 授权规范（调研）

> 调研日期：2026-11-10。问题来自 #79（地图 #76 的子票）：MCP 授权规范（2025-11-25、2026-07-28）要求客户端做什么，pi-mcp 1.4.0 的 `oauth/` 模块覆盖了哪些，Orqestra 还要自己补什么。
>
> 只用一手来源：
> - 规范 2025-11-25：<https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
> - 规范 2026-07-28：拆成四页（`index`、`authorization-server-discovery`、`client-registration`、`security-considerations`）加 `changelog`，按规范仓库源码 `modelcontextprotocol/modelcontextprotocol@632a0c9a` 的 `docs/specification/2026-07-28/basic/authorization/*.mdx` 读，网页在 <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
> - pi-mcp：本地安装的 `node_modules/.pnpm/@earendil-works+pi-mcp@1.4.0/node_modules/@earendil-works/pi-mcp/dist/`，下文写成 `pi-mcp/dist/...`，行号对应 `.js` 文件。它的 OAuth 代码注明改编自 MCP TypeScript SDK v1.29.0。
> - Orqestra：`packages/tools/src/mcp.ts`、`packages/db/src/schema.ts` 中的 `mcpServer`、`apps/api/src/mcp-servers.ts`、`apps/api/src/app.ts`。
>
> 标「推断」的内容是我从代码得出的结论，没有直接出处。

## 0. 结论

1. **注册方式**：规范要求的优先级是 预注册 → Client ID Metadata Document（CIMD）→ DCR → 让用户手填。2026-07-28 把 DCR 标为 Deprecated，只为兼容保留。pi-mcp 三种都支持，顺序也一样，但要不要用 CIMD 由应用通过 `clientMetadataDocument()` 回调决定。Orqestra 要做两件事：在 `{ORQESTRA_URL}` 下托管一份 CIMD JSON，并为 Admin 提供填写预注册 client_id/secret 的地方。
2. **回调**：pi-mcp 自带的 `OAuthCallbackServer` 是一个回环 `node:http` 服务，给 CLI 用，不适合 Orqestra。Orqestra 的 api 要自己提供 HTTPS 回调路由，按 `state` 找到对应的（User, MCP Server），再调用 `authorizeMcp(provider, { serverUrl, authorizationCode, iss })`。授权跳转本身由应用的 `onRedirect` 交给浏览器。
3. **刷新**：pi-mcp 只在收到 401 后才刷新，不会在过期前主动刷新。同一个 provider 实例内的并发 401 共用一次刷新。Orqestra 的 api 和 worker 是多个进程，轮换的 refresh token 必须在存储层加锁。**撤销**：两版规范都没有要求，pi-mcp 也没有实现。Orqestra 要自己做“断开连接”：删除令牌；如果 AS 元数据里有 `revocation_endpoint`，可以顺手调一次 RFC 7009 撤销。
4. **没有 OAuth 的服务端**：规范把授权定为 OPTIONAL。服务端不返回 401，就照常连接。Orqestra 现有的“Admin 配置静态请求头”继续保留，作为非 OAuth 方式。需要注意：服务端返回 401 但没有 Protected Resource Metadata 时，pi-mcp 会退回到 2025-03-26 的旧行为（把 MCP 地址的源站当成 AS，端点默认 `/authorize` `/token` `/register`），而 2025-11-25 起规范在这种情况下的写法是 “Abort or use pre-configured values”。
5. **令牌存储**：pi-mcp 暴露两层接口。简单的是 `McpOAuthStateStore { load, save }`，把一个服务器的全部 OAuth 状态当一个对象读写，交给 `McpOAuthProvider` 用。完整的是 `OAuthClientProvider` 接口，可以整个自己实现。由 Orqestra 实现，按（User, MCP Server）存，用 `ORQESTRA_ENCRYPTION_KEY` 加密，和 `mcp_server.headers` 的做法一样。
6. **顺带发现**：pi-mcp 1.4.0 的 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`，`SUPPORTED_PROTOCOL_VERSIONS` 里**没有** `2026-07-28`（`pi-mcp/dist/protocol/types.js:1-6`）。它只在 `structuredContent` 等个别地方兼容了 2026-07-28。地图 #76 “已知事实”里“pi-mcp 1.4.0 支持的协议版本含 `2026-07-28`”这一条不成立，会影响 #80。不过它的 OAuth 部分已经实现了 2026-07-28 新增的 `iss` 校验（SEP-2468）、`application_type`（SEP-837）和 step-up 合并 scope。

## 1. 规范对客户端的要求（两版对照）

| 主题 | 2025-11-25 | 2026-07-28 的变化 |
|---|---|---|
| 适用范围 | HTTP 传输 SHOULD 遵守；STDIO SHOULD NOT，凭据从环境里取；授权整体 OPTIONAL | 不变 |
| AS 发现 | 客户端 MUST 通过 Protected Resource Metadata（RFC 9728）找 AS：优先用 401 `WWW-Authenticate` 里的 `resource_metadata`，没有就依次试 `/.well-known/oauth-protected-resource<path>` 和根路径；都没有时时序图写的是 “Abort or use pre-configured values” | 新增：拿到 AS 元数据后 MUST 校验其 `issuer` 和构造 well-known URL 时用的 issuer 完全一致，不一致 MUST NOT 使用（`authorization-server-discovery.mdx:94`） |
| AS 元数据 | MUST 同时支持 RFC 8414 和 OIDC Discovery，按规定顺序试 2 个或 3 个 URL | 不变 |
| 客户端注册 | CIMD SHOULD，DCR MAY；同时支持多种时的优先级：预注册 → CIMD（AS 声明 `client_id_metadata_document_supported`）→ DCR（AS 有 `registration_endpoint`）→ 让用户填写 | DCR **Deprecated**（changelog 弃用第 4 条，PR #2858）；DCR 时 MUST 带合适的 `application_type`（SEP-837）；新增 *Authorization Server Binding*：持久化的 client 凭据 MUST 按 AS 的 `issuer` 存，AS 换了就 MUST NOT 复用，MUST 重新注册（SEP-2352）。CIMD 的 client_id 可以跨 AS 使用 |
| CIMD 客户端要求 | `client_id` 是带路径的 https URL，文档至少包含 `client_id`、`client_name`、`redirect_uris`，`client_id` 和 URL 完全一致 | 不变 |
| PKCE | MUST，S256；MUST 先从 AS 元数据确认支持：`code_challenge_methods_supported` **缺失就 MUST 拒绝继续** | 不变 |
| resource 参数 | RFC 8707，授权请求和令牌请求都 MUST 带，值为 MCP 服务器的规范 URI；“MUST send this parameter regardless of whether authorization servers support it” | 不变 |
| state | SHOULD 使用并校验 | 不变 |
| iss | 未提 | 新增 *Authorization Response Validation*：跳转前 MUST 记下 issuer，并和 PKCE verifier 存在同一条记录里；收到响应后按 RFC 9207 的表格校验：元数据声明支持但响应里没有 `iss` 就拒绝；只要有 `iss` 就做简单字符串比较；错误响应同样校验，不匹配时 MUST NOT 展示 error（`index.mdx:146-160`、`198-203`） |
| 重定向 URI | MUST 是 localhost 或 HTTPS，并在 AS 注册过 | 不变 |
| 令牌使用 | 每个 HTTP 请求 MUST 带 `Authorization: Bearer`，MUST NOT 放在 query 里；MUST NOT 把别的 AS 签发的令牌发给 MCP 服务器 | 不变 |
| scope | 优先用 `WWW-Authenticate` 的 `scope`，没有就用 PRM 的全部 `scopes_supported`，都没有就不带 | step-up 时 scope 取“之前请求过的 scope ∪ 本次挑战的 scope”（`index.mdx:389`） |
| step-up | 遇到 403 `insufficient_scope` 时 SHOULD 重新授权，并 SHOULD 限制重试次数 | 不变 |
| 刷新令牌 | 只要求公共客户端的 refresh token 由 AS 轮换（AS 侧 MUST） | 新增 *Refresh Tokens* 节：客户端 MUST 在传输和存储中保密 refresh token；SHOULD 在 `grant_types` 里写 `refresh_token`；AS 的 `scopes_supported` 含 `offline_access` 时 MAY 请求它；MUST NOT 假定一定会拿到 refresh token |
| 撤销 | **未规定** | **未规定**（四页和 changelog 都没有 “revoc”） |
| 令牌存储 | “Clients and servers MUST implement secure token storage”（OAuth 2.1 §7.1） | 不变 |

## 2. pi-mcp 1.4.0 怎么做

**模块**（`pi-mcp/dist/oauth/index.js`）：`discovery`（PRM 和 AS 发现、`WWW-Authenticate` 解析、`selectResource`）、`flow`（`authorizeMcp`、`registerClient`、`startAuthorization`、`exchangeAuthorizationCode`、`refreshAuthorization`、`stepUpScope`、`adaptOAuthProvider`）、`provider`（`McpOAuthProvider`、`MemoryOAuthStateStore`）、`callback`（`OAuthCallbackServer`）、`errors`。README 写明：“The package does not open a browser or choose where credentials are stored.”

**接入点**：`StreamableHttpTransport` 的 `authProvider?: AuthProvider` 选项（`transports/streamable-http.d.ts`）。`AuthProvider` 只有两个方法：`token()` 和 `onUnauthorized(ctx)`（`auth-provider.d.ts`）。传输层对每个请求调用 `token()`，并设置 `Authorization: Bearer`（`streamable-http.js:263`，会覆盖静态 `headers` 里同名的头）。遇到 401，或者 403 带 `insufficient_scope` 时，调用一次 `onUnauthorized` 再重试，**只重试一次**（`:239`）。`adaptOAuthProvider(provider)` 把 `OAuthClientProvider` 适配成 `AuthProvider`（`flow.js:303`）。

**`authorizeMcp` 的流程**（`flow.js:167-300`）：
1. 发现：优先用 provider 缓存的 `discoveryState`；否则走 `discoverOAuthServerInfo`，先 PRM，再按顺序试 AS 元数据 URL，并校验 issuer（`discovery.js:91`）。也可以传 `authorizationServerMetadataUrl`，直接指定 AS 元数据，跳过发现。
2. 选 resource（`selectResource`，PRM 的 `resource` 要和 MCP 地址同源且是它的路径前缀）和 scope（参数 → PRM `scopes_supported` → `clientMetadata.scope`）。
3. 客户端：已存储或预配置的 client → 应用的 `clientMetadataDocument(metadata)` 返回的 CIMD（要求 https 且有路径）→ DCR（`registerClient`，自动推断 `application_type`，`flow.js:17`）。
4. 如果带了 `authorizationCode`：按 RFC 9207 校验 `iss`（`flow.js:235`），用 code 和 verifier 换令牌，存下来，返回 `AUTHORIZED`。
5. 否则如果有 refresh token，就刷新；刷新失败且不是硬错误时，继续往下。
6. 否则生成 PKCE（S256）和 state，构造授权 URL（带 `resource`、`scope`；scope 含 `offline_access` 时加 `prompt=consent`），保存 verifier，调用 `redirectToAuthorization`，返回 `REDIRECT`。
7. 外层：遇到 `invalid_client` 或 `unauthorized_client`，清空全部状态重来一次；遇到 `invalid_grant`，只清令牌重来一次。

`adaptOAuthProvider` 收到 `REDIRECT` 时抛出 `McpOAuthAuthorizationRequiredError`，意思是需要用户交互。

## 3. 逐项回答

### 3.1 客户端注册：DCR 还是 CIMD

- 规范：两版都把 CIMD 列为 SHOULD，DCR 列为 MAY；2026-07-28 进一步弃用 DCR。优先级是 预注册 → CIMD → DCR → 用户手填。
- pi-mcp：顺序相同（`flow.js:198-215`）。CIMD 不会自动启用，要应用实现 `clientMetadataDocument(metadata)`，并自己检查 `metadata?.client_id_metadata_document_supported`。`McpOAuthProvider` 的构造参数 `clientId`、`clientSecret` 就是预注册路径。
- Orqestra 需要补：
  - 在 `{ORQESTRA_URL}` 下用固定的带路径 URL 托管 CIMD JSON，例如 `GET /oauth/client-metadata.json`：`client_id` 就是这个 URL，再加 `client_name: "Orqestra"`、`redirect_uris: [回调 URL]`、`grant_types: ["authorization_code","refresh_token"]`、`token_endpoint_auth_method: "none"`。
  - **推断**：自托管时，`ORQESTRA_URL` 往往只在内网可达，公网上的 AS 抓不到这份 CIMD，所以 DCR 和预注册不能省。`mcp_server` 表需要可选的预注册 `client_id`/`client_secret`（secret 加密存放），由 Admin 在 `/console/mcp` 里填写。
  - 选择逻辑：预注册 > AS 声明支持 CIMD 且 `ORQESTRA_URL` 是 https > DCR > 报错，提示 Admin 去填预注册信息。

### 3.2 授权码加 PKCE 的回调由谁承接

- pi-mcp：PKCE、state、构造授权 URL、用 code 换令牌、`iss` 校验都已实现。`OAuthCallbackServer.listen()` 默认绑定 `127.0.0.1` 的随机端口（`callback.js:21-22`），只适合本机 CLI。
- Orqestra 的 api 需要提供（**推断**，参照 `app.ts` 里 Polaris 的 `/auth/callback` 和 `/api` 分组）：
  1. **发起授权**：例如 `POST /api/mcp-servers/:id/connect`（已登录 User）。为这个（User, MCP Server）建 provider，`onRedirect` 只记下授权 URL；调用 `authorizeMcp`，拿到 `REDIRECT` 后把 URL 返回给前端，由前端在浏览器里打开。
  2. **回调**：例如 `GET /api/mcp-oauth/callback`（URL 写进 CIMD 和 DCR 的 `redirect_uris`；规范要求 HTTPS，或者 localhost）。读取 `code`、`state`、`iss`、`error`，**按 `state` 找到对应的（User, MCP Server）**，并核对它和当前 Session 的 User 是否一致；然后 `authorizeMcp(provider, { serverUrl, authorizationCode: code, iss })`，最后重定向回控制台或对话页。
  3. **CIMD 文档**：见 3.1。
  4. **断开连接**：例如 `DELETE /api/mcp-servers/:id/connection`，见 3.3。
- 注意：`McpOAuthProvider.state()` 在 `invalidateCredentials("all")` 之前一直复用同一个 state（`provider.js:37-43`），并不是每次授权重新生成。而且 state 存在状态对象内部，没法反查。所以 Orqestra 需要一张待授权表（state → User、MCP Server、过期时间），或者自己实现 `OAuthClientProvider.state()`，每次生成新的 state。
- Run 中途（worker 进程）遇到 `McpOAuthAuthorizationRequiredError`，不能在 worker 里完成授权。**推断**：这个 MCP Server 在这次 Run 里按“不可用”处理（`mcpTools` 已经会跳过连不上的服务器），并告诉 User 要先去连接。具体的交互留给 grilling 票决定。

### 3.3 令牌刷新与撤销

- 刷新：pi-mcp 只在收到 401 后刷新（`adaptOAuthProvider`）。`tokensExpireAt` 只记录不使用，`token()` 也不看它（`provider.js:56-65`、`flow.js:306`）。并发 401 在**同一个 adapter 实例内**共用一次刷新，而且不会用旧 token 再刷一次，避免轮换的 refresh token 失效。刷新时如果响应没带新 refresh token，就保留旧的（`refreshAuthorization`）。遇到 `invalid_grant`，清掉令牌，走重新授权。
- Orqestra 需要补：
  - **跨进程互斥**（**推断**）：api 和 worker 是不同进程，一个 User 同时可能有多个 Run，每个 Run 各自创建 adapter，`inFlight` 去重管不到别的实例。AS 轮换 refresh token 时（公共客户端 MUST 轮换），两个进程同时刷新，后一个会拿着已经作废的 token 去刷，拿到 `invalid_grant` 后清掉令牌，用户就被迫重新授权。所以存储层要在刷新时锁住这一行（例如 `SELECT ... FOR UPDATE`，或者 advisory lock），拿到锁后重新读一遍，如果令牌已经被别人换过就直接用新的。
  - 可选：在 `token()` 里根据 `tokensExpireAt` 提前刷新，少一次 401 往返。
  - 可选（2026-07-28 的 MAY）：AS 的 `scopes_supported` 含 `offline_access` 时，把它加进 scope。pi-mcp 不会自动加。
- 撤销：两版规范都没有规定，pi-mcp 也没有 RFC 7009 的实现（`dist` 里搜不到 “revoc”）。AS 元数据里的其他字段会原样保留（`types.js` 里的 `...input`），所以 `revocation_endpoint` 可以从 `discoveryState().authorizationServerMetadata` 里读到。Orqestra 的“断开连接”至少要删除本地令牌；如果有 `revocation_endpoint`，再 best-effort 撤销 refresh token。Admin 删除 MCP Server 时，要级联删除所有 User 的令牌。

### 3.4 服务端没有 OAuth 时怎么回退

- 规范：授权是 OPTIONAL，服务端不要求，客户端就不带令牌。规范层面不存在“回退”，只是不走授权流程。
- pi-mcp：不传 `authProvider`，或者 `token()` 返回 `undefined`，请求就不带 `Authorization`。现在 Orqestra 就是这样用的：`connectMcpServer` 只传 `headers`（`mcp.ts`）。
- 有一处偏离规范：服务端返回 401 却**没有 PRM** 时，`discoverOAuthServerInfo` 会把 PRM 的错误吞掉，然后把 `new URL("/", serverUrl)` 当作 AS（`discovery.js:125`）；AS 元数据也找不到时，端点默认用 `/authorize`、`/token`、`/register`（`flow.js:75,93,127`）。这时 `resource` 也不会发送（只有 PRM 存在时才有值），而规范说 resource MUST 无条件发送。这些是 2025-03-26 的旧行为；2025-11-25 起规范在这种情况下的写法是 “Abort or use pre-configured values”。
- Orqestra 的做法（**推断**）：
  - 每个 MCP Server 要有一个授权方式：`none/headers`（现状，Admin 配置静态头，所有 User 共用）或者 `oauth`（每个 User 自己授权）。
  - `oauth` 方式下，PRM 或 AS 元数据缺失时直接报错，不使用 pi-mcp 的旧回退；或者让 Admin 填 `authorizationServerMetadataUrl`，这就是规范说的 “pre-configured values”，pi-mcp 已支持。
  - 连接测试（`testMcpServer`）现在把 401/403 归为 `reason: "auth"`。可以在这时顺带做一次发现，告诉 Admin 这个服务器支持 OAuth。

### 3.5 令牌存储接口由谁实现

- pi-mcp 暴露两层：
  - `McpOAuthStateStore { load(): McpOAuthState | undefined; save(state) }`（`provider.d.ts`）。`McpOAuthState` = `{ serverUrl, clientInformation?, tokens?, tokensExpireAt?, codeVerifier?, oauthState?, discovery? }`。`McpOAuthProvider` 把写操作串行化，并且忽略 `serverUrl` 不匹配的状态，以免凭据串到别的服务器（`provider.js:114`）。默认实现 `MemoryOAuthStateStore` 只存在内存里。
  - `OAuthClientProvider` 接口（`flow.d.ts`），可以整个自己实现：`tokens/saveTokens`、`clientInformation/saveClientInformation`、`codeVerifier/saveCodeVerifier`、`state`、`discoveryState/saveDiscoveryState`、`invalidateCredentials`、`clientMetadataDocument`、`addClientAuthentication`（例如 `private_key_jwt`）。
- Orqestra 实现（**推断**）：
  - 新表，按（User, MCP Server）一行，存令牌、verifier 和发现缓存，敏感字段用 `ORQESTRA_ENCRYPTION_KEY` 加密。
  - DCR 拿到的 client 信息属于服务器（实际上属于 AS），不属于某个 User。如果所有 User 共用一个 client，就要拆开存，按 2026-07-28 的 SEP-2352 **以 AS 的 `issuer` 为键**。`McpOAuthProvider` 只按 `serverUrl` 区分，并且会一直使用缓存的发现结果，所以 AS 换了它察觉不到；只有等到 `invalid_client` 才会全部清掉。要满足 issuer 绑定，Orqestra 最好直接实现 `OAuthClientProvider`，或者在 store 里比较 `discovery.authorizationServerUrl`。

## 4. 能力对照表

| 规范要求 / 需要的能力 | pi-mcp 1.4.0 | Orqestra 需要补 |
|---|---|---|
| 解析 401 / `WWW-Authenticate`（`resource_metadata`、`scope`、`error`） | 有（`parseWwwAuthenticate`） | — |
| PRM 发现（header → path → root） | 有 | — |
| AS 元数据发现（RFC 8414 + OIDC，顺序正确）+ issuer 校验 | 有 | — |
| 没有 PRM 时 Abort，或使用预配置值 | **偏离**：退回把源站当 AS，端点用默认值；但支持 `authorizationServerMetadataUrl` 预配置 | `oauth` 方式下禁止旧回退（报错），可选让 Admin 预配置 AS 元数据 URL |
| 预注册 client | 有（`clientId`/`clientSecret`） | `mcp_server` 增加预注册字段和控制台表单，secret 加密 |
| CIMD | 有钩子（`clientMetadataDocument`），校验 https 和路径 | 托管 CIMD JSON；按 `client_id_metadata_document_supported` 和 `ORQESTRA_URL` 是否 https 决定是否启用 |
| DCR + `application_type` | 有（自动推断 native/web） | 回调是 https 的公网 URL，会推断成 `web`，可以直接用 |
| client 凭据按 AS issuer 绑定（2026-07-28） | **没有**（只按 serverUrl 区分） | store 以 issuer 为键，AS 变化时重新注册 |
| PKCE S256 | 有 | — |
| `code_challenge_methods_supported` 缺失时 MUST 拒绝 | **部分**：只在字段存在但不含 S256 时拒绝（`flow.js:72`） | 调 `authorizeMcp` 前自己检查发现结果，缺失就拒绝 |
| resource 参数（RFC 8707）始终发送 | **部分**：只有 PRM 存在时才发送 | 禁止旧回退后自然满足 |
| state 生成和校验 | 生成：有，但会复用；校验：只在 `OAuthCallbackServer` 里 | 回调路由按 state 查待授权记录并校验，每次授权生成新 state |
| `iss` 校验（RFC 9207，2026-07-28） | 有 | 回调把 `iss` 传给 `authorizeMcp` |
| 授权跳转（打开浏览器） | 只有 `onRedirect` 钩子 | 把授权 URL 交给前端 |
| 回调端点 | 只有回环 `OAuthCallbackServer` | api 增加 HTTPS 回调路由 |
| 每个请求带 Bearer | 有 | — |
| 401 后刷新、invalid_grant 后重新授权 | 有（只在单进程内去重） | 跨进程刷新加锁 |
| 过期前主动刷新 | 没有 | 可选 |
| `offline_access`（2026-07-28 MAY） | 只在 scope 已含它时加 `prompt=consent` | 可选：按 AS `scopes_supported` 添加 |
| step-up（403 `insufficient_scope`，合并 scope，限制重试） | 有（`stepUpScope`；传输层只重试一次） | 需要用户交互时，在 UI 上提示重新授权 |
| 令牌撤销 | 没有（规范也没要求） | 断开连接时删除令牌，有 `revocation_endpoint` 就 best-effort 撤销；删除 MCP Server 时级联删除 |
| 安全存储令牌 | 只有接口（`McpOAuthStateStore` / `OAuthClientProvider`），默认存内存 | 实现 DB 存储，加密，按（User, MCP Server）存 |
| HTTPS 端点 | token 端点和预配置的元数据 URL 强制 https（loopback 除外）；授权和注册端点不检查 | 可选：Admin 保存时校验 |
| Run 中需要授权时的处理 | 抛出 `McpOAuthAuthorizationRequiredError` | Run 内跳过这个服务器，并告诉 User 去连接（交互待 grilling） |
| 协议版本 2026-07-28 | **不在** `SUPPORTED_PROTOCOL_VERSIONS` 里 | 地图 #76 的已知事实要更正，交 #80 处理 |
