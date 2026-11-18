# 智能体在 Orrery 沙箱里改代码，接入 Git 与 Linear：分阶段计划

## 改什么

Orqestra 的智能体在 Orrery Sandbox 里 clone、改代码、commit、push、开 PR；Linear 里把 issue 指派给智能体，就开出一个 Conversation，回复写回 Linear。

定下来的边界：

- 依赖只从 Orqestra 指向 Orrery。Orrery 不出现 Orqestra 的任何概念。
- Git 凭证只由 Orqestra 保管：GitHub App 的 user token，存在现有的 MCP Connection 里（`mcp_connection.tokens`，有刷新和 advisory lock）。
- Orrery 删掉自己全部的 Git 管理：Git Provider、Git Account Link、`/git/credential`、Sandbox Token、`orrery git-credential`、`orrery token <provider>`、Exec 里的 `GIT_CONFIG_*` 注入。平台镜像**保留** `git` 和 `openssh-client`。
- Orrery 新增一个通用能力：Exec 级 `secrets: {ENV: secret_name}`，在创建 Exec 时解析，加密存在 Exec 行上，不进 `execs.env` 和 `stdin`（这两列今天明文持久化，见 `internal/api/execs.go:219-236`）。
- 凭证注入和平台无关：每个 Git Host 一行 `credential.https://<host>.helper`，helper 从环境变量读 token。GitHub、以后私有化的 Gitea、GitLab 都走这一套，加平台就是加一行配置。
- `gh` 只用于 GitHub API（开 PR），装在 Orqestra 自己的 Snapshot 里。
- 一个 Linear Agent Session 对应一个 Conversation。

已经做过的原型（scratchpad，可丢弃）：

- `gh auth git-credential get` 只靠 `GH_TOKEN` 就给出凭证，不需要登录。
- 按 host 配的 env helper：`github.com` 和 `gitea.example.com` 各自拿到自己的 token。
- `api.githubcopilot.com/mcp/` 的授权服务器是 `https://github.com/login/oauth`，RFC 8414 元数据可取，支持 S256 和 `refresh_token`，不支持动态注册。所以用 Orqestra 现有的“预注册 Client 的 per-User OAuth MCP Server”就能拿到 GitHub App user token。端到端还没跑通，见 Q0。

## PR 列表（按落地顺序）

| id | 仓库 | 内容 | 依赖 | 需操作者审 |
|---|---|---|---|---|
| O1 | orrery | ADR-0032 和 spec：Orrery 不管 Git，Exec 级 Secret | 无 | 是 |
| O2 | orrery | 删除 Git 功能 | O1 | 否 |
| O3 | orrery | Exec 级 Secret | O2 | 否 |
| Q3 | orqestra | Orqestra 自己的 Snapshot（加 gh） | 无 | 否 |
| Q0 | orqestra | 原型闸门：GitHub App 走 MCP Connection 授权 | 无 | 是（要你注册 GitHub App） |
| Q1 | orqestra | Orrery 客户端支持 Exec 的 `env`、`secrets` 和 `PUT /secrets` | O3 部署 | 否 |
| Q2 | orqestra | Git Host 配置和 token 注入 | Q0、Q1 | 是 |
| Q4 | orqestra | 智能体的 Git 工作约定（worktree、分支、PR） | Q2、Q3 | 是 |
| L2 | orqestra | Linear 安装（Admin，`actor=app`） | 无 | 是 |
| L3 | orqestra | Linear webhook 变成 Conversation | L2 | 是 |
| L4 | orqestra | Run 的回复写回 Linear | L3 | 是 |

依赖图：

```
O1 ─▶ O2 ─▶ O3 ─▶ (部署 Orrery) ─▶ Q1 ─┐
                                 Q0 ───┼─▶ Q2 ─▶ Q4
Q3（从 trunk 开，随时可合） ───────────┘        ▲
                                               │（Q4 的 live 要 Q3 的 gh）
L2 ─▶ L3 ─▶ L4        （和 Git 线互不依赖；“issue 到 PR”的整链验证要 Q4 和 L4 都在）
```

O2 先于 O3：先删再加，两者都改 `reconcile.go` 和 `secretenv.go`，串行避免冲突。

各 PR 可以碰的文件：

- O1：`docs/**`、`GLOSSARY.md`
- O2：`internal/{api,agent,cli,store}/**`、`client/**`、`web/**`、`e2e/**`、`scripts/e2e.sh`、`deploy/{compose.yaml,install.sh}`、`README.md`、新迁移 `000032_drop_git.up.sql`
- O3：`internal/{api,store,mcpserver}/**`、`client/**`、`sdk/python/**`、`e2e/**`、新迁移 `000033_exec_secrets.up.sql`
- Q1：`packages/tools/src/{orrery,sandbox}.ts` 和它们的测试
- Q2：`packages/db/src/schema.ts` 和新迁移、`packages/mcp/src/**`、`packages/tools/src/**`、`apps/worker/src/runtime/sandbox.ts`、`apps/api/src/mcp-servers*`、`apps/web/src/routes/console/**`、`apps/web/messages/*.json`、`GLOSSARY.md`、新 ADR
- Q3：新 `sandbox/Dockerfile`、`scripts/sandbox-snapshot.sh`、`README.md`
- Q4：`apps/worker/src/runtime/sandbox.ts`（bash 工具描述）、内置 Skill 文件
- L2、L3、L4：新 `packages/linear/**`、`apps/api/src/linear*.ts`、`apps/worker/src/**`、`packages/conversations/src/{index,runs}.ts`、`packages/db/src/schema.ts` 和新迁移、`apps/web/src/routes/console/**`、`apps/web/messages/*.json`、`GLOSSARY.md`、新 ADR

---

## O1：ADR-0032 和 spec

- [ ] 依赖：无
- [ ] 改的文件：新 `docs/adr/0032-orrery-runs-no-git.md`；ADR-0013 标为被 0032 取代；ADR-0016（Sandbox Token 部分）、ADR-0017（“Git and Secrets”）就地加状态说明；`docs/spec/{api,defaults,node-protocol,runtime,schema}.md`；`GLOSSARY.md`（删 Git Provider、Git Account Link、Sandbox Token）；删 `docs/research/{git-short-lived-credentials,sandbox-git-integration,recheck-git-secrets-vs-coder-daytona}.md`
- [ ] 一个改动：spec 改成“Orrery 不管理 Git 凭证；调用方用 Exec 级 `secrets` 注入”。`api.md` §4 给 `POST /sandboxes/{id}/execs` 加 `secrets?: {ENV_NAME: secret_name}`，写明：用 Sandbox owner 的 Secret，创建时解析，覆盖 Sandbox 级同名变量，不进 `env`、`stdin`，幂等重放不重新解析。`node-protocol.md` 写清合并顺序：env，然后 Sandbox `secret_env`，然后 Exec `secret_env`。`defaults.md` 保留 `git`、`openssh-client` 的说明，删掉“为 Git 认证放行 api 地址”。`runtime.md:217,225`（Generation 跳过 git `*.lock`）保留，它和凭证无关。
- [ ] 看到的结果：spec 里不再承诺 Git 关联
- [ ] 验证
  - [ ] unit：`rg -n "git/credential|git_links|Sandbox Token|ors_|git-credential" docs/spec GLOSSARY.md` 只剩 ADR 的历史说明
  - [ ] live：n/a，纯文档
  - [ ] perf：n/a，纯文档
  - [ ] 你审过 ADR-0032

## O2：删除 Orrery 的 Git 功能

- [ ] 依赖：O1
- [ ] 改的文件：以盘点结果为准
  - server：删 `internal/api/{git,gitconfig,gitcredential,sandboxtoken}.go` 和对应 `_test.go`；改 `routes.go:15,40-45,121`、`config.go:75-83,242-246`、`configfile.go`（Git 部分）、`openapi.go:35,147,337-400`、`auth.go:19-21,30,38-44,60,123-165`、`token.go:21,41-47`、`sandboxes.go:276,381-386,497`、`reconcile.go:217-229`（保留 `ORRERY_URL`）；重写 `polaris_webhook_db_test.go:79-180` 里依赖 `/git/credential` 的断言
  - store：`queries.sql` 删 GitLink 查询和 `token_ct`、`token_key_id`；新迁移 `000032_drop_git.up.sql`：`DROP TABLE git_links; ALTER TABLE sandboxes DROP COLUMN token_ct, DROP COLUMN token_key_id;`；`make sqlc`
  - agent：`internal/agent/exec.go:111-115` 删 `GIT_CONFIG_*`；改 `exec_test.go:270-295`、`local_test.go:272-273`
  - cli：删 `internal/cli/git.go` 和测试；`cli.go:109-112,130-133,189-190,480-499`。**保留**读取 `ORRERY_SANDBOX_TOKEN` 环境变量作为 API token 的默认值（CLI 和 Python parity 测试都在用）
  - SDK：`client/methods.go:121-142`、`client/types.go:101-116,475-480`、`client/client.go:46-48,165-168`、`client_test.go:18-31`
  - mcp：`internal/cli/mcp.go:20-23` 的 `ors_` 判断、`mcp_test.go:17`
  - console：删 `web/src/routes/_authed.git.tsx`；改 `_authed.tsx:5,61,82`、`src/api.ts:61-72`、`src/lib/request-scope.ts:17`；重新生成 `routeTree.gen.ts`；删 `messages/{en,zh}.json` 的 `git_*`、`nav_git`
  - e2e：**先把** `setUserSandboxQuota`、`execInSandbox` 从 `e2e/git_test.go` 挪到共用文件，再删 `e2e/{git,sandboxtoken}_test.go`；`scripts/e2e.sh:186-230,321-326,480-484`；`deploy/compose.yaml:92-114,146-147`（gitea）；`deploy/install.sh:475-478`
  - Secret 名的保留前缀 `GIT_`（`internal/api/secrets.go:22`、`web/src/lib/secrets.ts:6`、`secretenv.go:183`）：删掉，它只是为注入而设
  - `README.md:10,63,78`
- [ ] 一个改动：Orrery 不再碰 Git 凭证。平台镜像的 `git`、`openssh-client` 不动。
- [ ] 看到的结果：console 没有 Git 页；创建 Sandbox 不再需要 `encryption_keys`；Exec 的环境里没有 `GIT_CONFIG_*`
- [ ] 验证
  - [ ] unit：`make vet && make test && make web-check && make console`，Python `unittest discover`
  - [ ] live：`./scripts/e2e.sh` 全绿，再加三个断言
    - [ ] Exec `env` 输出里没有 `GIT_CONFIG_COUNT`
    - [ ] 调用方传 `env: {GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x.y", GIT_CONFIG_VALUE_0: "z"}`，`git config x.y` 打印 `z`（证明调用方配置不再被覆盖）
    - [ ] `git --version` 退出码为 0
  - [ ] live：没配 `encryption_keys` 的部署能创建 Sandbox
  - [ ] perf：n/a，纯删除
  - [ ] `rg -n -i "gitlink|git_link|sandboxtoken|git-credential" internal client web/src cmd` 为空

## O3：Exec 级 Secret

- [ ] 依赖：O2
- [ ] 改的文件
  - 迁移 `000033_exec_secrets.up.sql`：`ALTER TABLE execs ADD COLUMN secret_env_ct bytea;`
  - `execs.go:28` 加 `Secrets map[string]string`；`:193` 之后逐个调用 `secretEnvNameProblem` 和 `requireSecrets`；插入前调用 `writeSecretSnapshot(..., sb.OwnerID, ...)`，用 Sandbox owner 而不是请求者
  - `queries.sql:709-713` 的 `CreateExec` 加 `secret_env_ct`；`make sqlc`
  - `reconcile.go` 的 startExec 用 `row.SandboxOwnerID` 解密，覆盖 Sandbox 的 map，Exec 优先
  - `finishExec` 把 `secret_env_ct` 置 NULL，Exec 结束后不留密文
  - `openapi.go:786`、`client/types.go:393`、`sdk/python/orrery/client.py:308`、`internal/mcpserver/{tools.go:256,handlers.go:179,212}`
- [ ] 一个改动：创建 Exec 时可以按名字引用 owner 的 Secret
- [ ] 看到的结果：先 `PUT /secrets/x` 写入新值，下一个 Exec 立刻看到新值，Sandbox 不用重启
- [ ] 验证
  - [ ] unit：`internal/api/execs_test.go` 覆盖这些情况：名字不合法时报 `invalid_request`；引用不存在的 Secret 被拒；同名时 Exec 覆盖 Sandbox；用 Idempotency-Key 重放时不重新解析
  - [ ] live：新 e2e `TestExecSecretInject`（照 `e2e/secret_test.go:140` 写）
    1. `PUT /secrets/t` 值为 `v1`
    2. 带 `secrets:{TOK:"t"}` 跑 `printenv TOK`，输出 `v1`
    3. `PUT /secrets/t` 值为 `v2`，不重启 Sandbox，再跑一次，输出 `v2`
    4. 查数据库 `select env::text, encode(stdin,'escape'), secret_env_ct from execs`：`env` 和 `stdin` 列里都没有 `v1`、`v2`；Exec 结束后 `secret_env_ct` 为 NULL
  - [ ] perf：指标是 `POST /execs` 到 Exec 进入 `finished` 的耗时，探针是 50 次 `true`。先在 trunk 上量 p50 作为基线；带 3 个 secrets 时 p50 比基线多出 20ms 以上就算失败
- [ ] 合并后由你部署 Orrery。部署是不可逆操作，我会停下来等你

## Q3：Orqestra 自己的 Snapshot

- [ ] 依赖：无
- [ ] 改的文件：新 `sandbox/Dockerfile`（`FROM` Orrery 平台镜像，它自带 git；再加 `gh` 的官方 apt 源）、新 `scripts/sandbox-snapshot.sh`（调 Orrery 的 `POST /snapshots`、`POST /snapshots/{id}/versions {build}`，打印 snapshot 名）、`README.md` 一段说明
- [ ] 一个改动：Orqestra 自己维护 Sandbox 的工具链
- [ ] 看到的结果：在 `/console/sandbox` 填上这个 snapshot 之后，新 Conversation 里 bash 能跑 `gh --version`
- [ ] 验证
  - [ ] unit：n/a，Dockerfile 和脚本没有分支逻辑
  - [ ] live：先跑一次脚本，填好 snapshot，再开一个 Conversation 让它运行 `git --version && gh --version`，两条都打印出版本号
  - [ ] perf：指标是新 Sandbox 第一次 bash 的耗时。先在 trunk 的 snapshot 上量基线；超过基线 2 倍算失败（镜像变大会拖慢拉取）

## Q0：原型闸门，GitHub App 走 MCP Connection 授权

不合并，只做实验，结果写进 Q2 的 PR 描述。

- [ ] 依赖：你在 GitHub 注册一个 GitHub App。保持“user token 过期”开启；Callback URL 填 Orqestra 的 `/api/connections/callback`；权限给 Contents、Pull requests 读写；安装到一个测试仓库
- [ ] 步骤
  1. `/console` 新增 MCP Server：url `https://api.githubcopilot.com/mcp/`，auth 选 oauth，填 GitHub App 的 client id 和 secret
  2. 在 `/connections` 授权
  3. 检查 `mcp_connection` 里有 access token、refresh token 和过期时间
  4. 用解密后的 token 跑 `gh api user`，再对测试仓库 `git push` 一个分支
  5. 把过期时间改成过去的时间，触发一次刷新，确认拿到新 token、旧 token 失效
- [ ] 通过条件：5 步全部成功
- [ ] 失败怎么办：如果 MCP SDK 和 GitHub 授权服务器不兼容（比如 `resource` 参数被拒，或 token 响应是 form 编码），Q2 改成一个独立的 GitHub OAuth 流程，复用 `packages/mcp/src/oauth.ts` 的 PKCE 和存储，不挂在 MCP Server 下。Q2 的改动会变大，我会先回来跟你说

## Q1：Orrery 客户端

- [ ] 依赖：O3 已部署
- [ ] 改的文件：`packages/tools/src/orrery.ts`（`createExec` 接受 `env`、`secrets`；新增 `putSecret(name, value)`）、`packages/tools/src/sandbox.ts`（`runCommand` 透传 `env`、`secrets`）、`orrery.test.ts`
- [ ] 一个改动：Orqestra 能按名字给 Exec 注入 Secret
- [ ] 看到的结果：调用方能看到的行为没有变化
- [ ] 验证
  - [ ] unit：`orrery.test.ts` 用假的 fetch 断言请求体里 `secrets` 的结构，并确认 `putSecret` 的值只出现在 `PUT /secrets/{name}` 的请求体里
  - [ ] live：一次性脚本，对你部署的 Orrery 依次调用 `putSecret`、`runCommand("printenv TOK", {secrets})`，输出等于写入的值
  - [ ] perf：n/a，没有新增调用；`putSecret` 的调用频率在 Q2 里量

## Q2：Git Host 配置和 token 注入

- [ ] 依赖：Q0 通过、Q1
- [ ] 数据结构：`mcp_server` 加三个可空列
  - `git_host`：比如 `github.com`
  - `git_username`：比如 `x-access-token`，GitLab 用 `oauth2`
  - `token_env`：比如 `GH_TOKEN`，GitLab 可以用 `GITLAB_TOKEN`
  三列要么都为空，要么都有值，用 check 约束保证。不新建表：一个 Git Host 就是一个按 User 授权的 MCP Server，它的 Connection 发 token
- [ ] 改的文件：`schema.ts` 和新迁移；`packages/mcp/src/connections.ts`（新增“取一个有效的 access token，必要时刷新”，复用现有 refresh 和 advisory lock）；`apps/worker/src/runtime/sandbox.ts`（bash 和 Skill 上传之外的每次 Exec 都带注入）；console 的 MCP Server 表单加三个字段和对应的 messages；`GLOSSARY.md` 加 Git Host；新 ADR“Git 凭证属于 User 的 Connection，按 Exec 注入”
- [ ] 一个改动：每次 bash 之前，worker 对每个配了 `git_host`、且 Run 的 User 已授权的 MCP Server 做这几件事
  1. 取有效 token
  2. token 变了才调 `PUT /secrets/orq-git-<sha256(userId:serverId) 前 16 位>`（每个进程在内存里缓存上次写入的 token 哈希）
  3. 在 Exec 上带 `secrets: {<token_env>: <secret 名>}`
  4. 在 Exec 上带 `env`：`GIT_CONFIG_COUNT` 等于 host 数，每个 host 一行 `credential.https://<host>.helper = !f(){ echo username=<git_username>; echo password=$<token_env>; }; f`。这几个值不含秘密
  User 没授权时不注入；bash 工具的描述里告诉智能体，push 认证失败时提示 User 去 `/connections` 授权。Subagent 用根 Conversation 的 User
- [ ] 看到的结果：User 授权一次 GitHub 之后，智能体就能 clone 私有仓库、push 分支、`gh pr create`
- [ ] 验证
  - [ ] unit：worker 的测试用假的 Orrery 断言三件事：Exec 请求里 `env`、`argv`、`stdin` 都不含 token，只出现在 `putSecret` 的值里；token 没变时第二次 bash 不再调用 `putSecret`；过期时会先刷新再写入
  - [ ] unit：两个 Run 同时刷新同一个 Connection 时只刷新一次（GitHub 的 refresh token 用过就失效）
  - [ ] live（在你的开发环境，连真 Orrery 和真 GitHub App）：在一个新 Conversation 里让智能体“clone 测试仓库，改 README，push 到 `orqestra/test` 分支，开 PR”。通过条件：GitHub 上出现这个 PR，作者是你，带 via App 标记
  - [ ] live：在 Orrery 数据库跑 `select env::text, encode(stdin,'escape') from execs`，用 `grep ghu_` 查不到任何结果
  - [ ] live：把 `mcp_connection` 里的过期时间改成过去的时间，再让智能体 push 一次，成功
  - [ ] perf：指标是 bash 跑 `true` 的往返耗时 p50，探针是 30 次。先在 trunk 上量基线；token 没变时比基线多出 30ms 以上算失败，刷新那一次单独记录、不算失败
  - [ ] 你审过 console 表单

## Q4：智能体的 Git 工作约定

- [ ] 依赖：Q2、Q3
- [ ] 改的文件：`apps/worker/src/runtime/sandbox.ts`（bash 工具描述，一两句）、一个内置的 `git` Skill（放在现有内置 Skill 的位置）
- [ ] 一个改动：写清楚约定
  - 仓库 clone 到 `/workspace/<repo>`，在 `orqestra/<slug>` 分支上工作
  - 每个 Subagent 用 `git worktree add /workspace/subagents/<自己的 id>/<repo>` 建自己的子分支，不和别人共用工作区
  - 不 push 默认分支
  - 用 `gh pr create` 开 PR，并把链接告诉 User
- [ ] 看到的结果：多个 Subagent 并行改同一个仓库时不会互相打架
- [ ] 验证
  - [ ] unit：n/a，只改了文字
  - [ ] live：让父 Agent 开 2 个 Subagent，分别改同一仓库的两个文件，最后合到一个 PR。通过条件：transcript 里没有 `index.lock` 报错；PR 里两处改动都在
  - [ ] perf：n/a
  - [ ] 你审过 Agent 的行为

## L2：Linear 安装

- [ ] 依赖：无
- [ ] 改的文件：新 `packages/linear/`（OAuth 和 GraphQL 的最小客户端）；`schema.ts` 加单行表 `linear_installation`，字段为：client id、加密的 client secret、加密的 webhook secret、加密的 tokens、workspace 名、默认 Agent id、团队到仓库的映射（jsonb，形如 `{teamKey: "owner/repo"}`）；`apps/api` 的 Admin 路由，包括安装起点和 callback；`apps/web/src/routes/console/linear.tsx`；messages
- [ ] 一个改动：Admin 在 console 里填好 client id、secret 和 webhook secret，点“安装”，走 `actor=app` 授权，回调后存下 token，页面显示 workspace 名
- [ ] 看到的结果：`/console/linear` 显示“已连接到 <workspace>”
- [ ] 验证
  - [ ] unit：callback 校验 state，只能用一次；密文不会返回给浏览器
  - [ ] live：用 verify-orqestra 驱动 console 表单（Linear 授权页那一步需要你手点），完成后页面显示 workspace 名；在 Linear 的指派菜单里能看到这个智能体
  - [ ] perf：n/a
  - [ ] 你审过 console 页面
- [ ] 写之前要先查清：Linear 的 OAuth token 会不会过期、怎么刷新。我还没有核实

## L3：Linear webhook 变成 Conversation

- [ ] 依赖：L2
- [ ] 改的文件：`apps/api/src/linear-webhook.ts`（不需要登录）；`schema.ts` 新表 `linear_session(agent_session_id text primary key, conversation_id uuid unique references conversation)`，`InputOrigin` 加 `"linear"`；worker 加一个处理 Linear 事件的 BullMQ job；`packages/conversations/src/index.ts` 让 `send` 接受 `origin`；新 ADR“一个 Linear Agent Session 是一个 Conversation”；`GLOSSARY.md`
- [ ] 一个改动
  1. webhook 用 webhook secret 校验 HMAC 签名，检查时间戳，放进队列，5 秒内返回 200
  2. `created` 事件：
     - 按 email 找 Orqestra 的 `user`。找不到就回一条 `error` activity，告诉对方“请先登录 Orqestra”
     - 用默认 Agent 开 Conversation。首条消息包含 issue 的标题、描述、链接，以及按团队映射到的仓库
     - 写入 `linear_session`
     - 10 秒内回一条 `thought` activity
  3. `prompted` 事件：把 `agentActivity.body` 发进同一个 Conversation
  4. 重复投递时，靠 `agent_session_id` 主键保证幂等
- [ ] 看到的结果：在 Linear 把 issue 指派给智能体，几秒内那位 User 的侧栏出现一个新 Conversation，开始干活
- [ ] 验证
  - [ ] unit：签名错误或时间戳过旧时返回 401；同一个 payload 送两次只建一个 Conversation（db 测试）；email 找不到时不建 Conversation
  - [ ] live：在测试 workspace 指派一个 issue，Orqestra 侧栏出现 Conversation，Linear 里 10 秒内显示 thought；在 Linear 追问一句，同一个 Conversation 收到这条消息
  - [ ] perf：指标是 webhook 的响应时间，探针是 20 次本地签名请求，p99 超过 500ms 算失败（Linear 的上限是 5 秒）
  - [ ] 你审过 Conversation 的入口和显示（`origin: linear` 在 UI 里怎么标）

## L4：回复写回 Linear

- [ ] 依赖：L3
- [ ] 改的文件：worker 在 Run 结束时，如果 Conversation 有 `linear_session`，就把最后一条回复写成 `response` activity，Run 失败时写 `error` activity；`packages/linear` 加 `agentActivityCreate`
- [ ] 一个改动：Linear 能看到智能体的结论。中间的工具调用不同步，以后有需要再加
- [ ] 看到的结果：Linear issue 里出现智能体的回复和 PR 链接
- [ ] 验证
  - [ ] unit：Run 正常结束和失败各写一条 activity；没有 `linear_session` 的 Conversation 什么都不写
  - [ ] live：端到端，要求 Q4 已合并。在 Linear 指派“改 README 一行”，通过条件：GitHub 出现 PR，Linear issue 里出现带 PR 链接的回复，追问后又出现第二条回复
  - [ ] perf：n/a，每个 Run 只多一次请求
  - [ ] 你审过回复的格式

## 还没证明的

- Q0：GitHub App 的 token 能不能走 MCP SDK 的 OAuth 流程，端到端没跑过
- Linear OAuth token 的有效期和刷新方式；Linear 的 webhook 签名头名称。都按文档写，没实测
- 旧版 Orrery 收到带 `secrets` 的 Exec 请求时，会报错还是静默忽略。Q1 之后 Orqestra 只能连新版 Orrery
- 不受控的风险：智能体能在沙箱里读到 `GH_TOKEN`，而 egress 是全开的。靠 GitHub App 的仓库范围和最小权限把影响限制住，这个计划不解决 prompt injection
