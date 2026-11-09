# Orqestra

[![CI](https://github.com/zibyn/orqestra/actions/workflows/ci.yml/badge.svg)](https://github.com/zibyn/orqestra/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zibyn/orqestra)](https://github.com/zibyn/orqestra/releases)

Orqestra 是一个自托管平台：登录的 User 与 AI Agent 对话，身份交给外部的身份提供方 Polaris 管理。

## 功能

- **Agent**：Admin 在控制台定义 Agent（指令、可用 Model、Tool、Skill），User 选一个开始对话。
- **Subagent**：Agent 可以把任务交给后台运行的 Subagent，完成后结果自动交回。
- **Provider 与 Model**：内置 pi 的 Provider 目录，填 API Key 即可启用；密钥在数据库中加密保存。
- **Tool**：Search / Scrape（Tavily、Firecrawl、DeepSeek）、MCP Server。
- **Skill**：遵循 Agent Skills 标准，脚本在 [orrery](https://github.com/zibyn/orrery) 的 Sandbox 里执行。
- **配置热加载**：控制台保存后 web 与 worker 自动重新加载，无需重启。

## 架构

| 组件 | 说明 |
| --- | --- |
| `apps/web` | TanStack Start 应用（Node，Nitro 构建），提供界面和 API |
| `apps/worker` | BullMQ worker（Bun），执行 Agent 的 Run；队列存在 Postgres 的 `bullmq` schema |
| `packages/db` | Drizzle schema、client 与迁移 |
| `packages/conversations` | Conversation 生命周期（Run、Inbox、Subagent、Notification），唯一读写这些表的代码 |
| `packages/config` | Catalog（pi 内置的 Provider 与 Model）以及 Admin 在数据库中配置的一切 |
| `packages/tools` | Agent 可用的 Tool |

web 和 worker 共用一个 PostgreSQL。领域术语见 [`GLOSSARY.md`](GLOSSARY.md)，架构决策见 [`docs/adr/`](docs/adr/)。

## 使用 Docker Compose 部署

需要 Docker（含 Compose v2）和一个配置好的 Polaris 实例（见[配置 Polaris 登录](#配置-polaris-登录)）。

```bash
git clone https://github.com/zibyn/orqestra.git && cd orqestra
cp .env.example .env   # 填写各项，密钥用 openssl rand -base64 32 生成
docker compose up -d
```

Compose 启动四个服务：`postgres`、`migrate`（执行数据库迁移后退出）、`web`（默认端口 3000，可用 `PORT` 修改）和 `worker`。默认拉取 `ghcr.io/zibyn/orqestra-web` 与 `ghcr.io/zibyn/orqestra-worker` 的 `latest` 镜像；用 `ORQESTRA_VERSION=0.1.0` 固定版本，或用 `docker compose up -d --build` 从源码构建。

升级：`docker compose pull && docker compose up -d`，迁移会在 web 和 worker 启动前自动执行。

#### 从 PostgreSQL 17 升级到 18

v0.1.2 之后的 Compose 使用 PostgreSQL 18 和新的数据卷 `postgres18`；旧卷 `orqestra_postgres` 不会被改动，但 18 不能直接读取 17 的数据，需要导出再导入：

```bash
# 1. 更新代码前，用旧版本（17）导出
docker compose stop web worker
docker compose exec -T postgres pg_dump -U orqestra -d orqestra -Fc > orqestra.dump

# 2. 更新后只启动 18，导入数据
git pull
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U orqestra -d orqestra --no-owner < orqestra.dump

# 3. 启动其余服务（迁移会自动执行）
docker compose up -d
```

确认数据无误后，可用 `docker volume rm orqestra_postgres` 删除旧卷。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ORQESTRA_URL` | 是 | Orqestra 的访问地址，不带结尾斜杠 |
| `ORQESTRA_ENCRYPTION_KEY` | 是 | 加密数据库中的 API Key（32 字节 base64）；更换后已存的 Key 无法读取，需在 `/console/providers` 重新填写 |
| `POLARIS_ISSUER` | 是 | Polaris 实例地址 |
| `POLARIS_CLIENT_ID` / `POLARIS_CLIENT_SECRET` | 是 | Polaris 上的 Web Application |
| `POLARIS_AUDIENCE` | 是 | access token 的 `aud`，即 Orqestra 在 Polaris 上的 API 标识 |
| `POLARIS_SECRET` | 是 | 加密会话 Cookie（至少 32 字符）；更换后所有人需重新登录 |
| `DATABASE_URL` | Compose 外必填 | PostgreSQL 连接串；Compose 根据 `POSTGRES_PASSWORD` 自动生成 |
| `POSTGRES_PASSWORD` | 否 | Compose 内置 Postgres 的密码，默认 `orqestra` |
| `WORKER_CONCURRENCY` / `SUBAGENT_CONCURRENCY` / `PROVIDER_CONCURRENCY` | 否 | worker 并发度（正整数） |

## 本地开发

需要 Node 24、[pnpm](https://pnpm.io) 11、[Bun](https://bun.sh) 1.4 和 PostgreSQL。

```bash
pnpm install
cp .env.example .env.local   # 填写，并设置 DATABASE_URL
pnpm db:migrate
pnpm dev                     # 同时启动 web（http://localhost:3000）和 worker
```

| 命令 | 说明 |
| --- | --- |
| `pnpm web` / `pnpm worker` | 只启动 web 或 worker |
| `pnpm build` | 构建 web（输出在 `apps/web/.output`，`node apps/web/.output/server/index.mjs` 运行） |
| `pnpm test` | 运行所有测试；`*.db.test.ts` 需要设置 `TEST_DATABASE_URL`，指向一个已迁移、可随时清空的数据库 |
| `pnpm lint` / `pnpm format` / `pnpm check` | Biome 检查与格式化 |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:studio` | Drizzle 迁移与数据库管理 |

环境变量放在根目录的 `.env.local`，所有 package 共用。shadcn、paraglide 等命令在 `apps/web` 下运行。

## 配置

### 配置 Polaris 登录

Orqestra 不保存自己的用户：Polaris 管理 User 池并负责登录（见 [ADR 0003](docs/adr/0003-polaris-owns-the-user-pool.md)）。在 Polaris 控制台中：

1. 为 Orqestra 创建一个 API（标识如 `orqestra`，填入 `POLARIS_AUDIENCE`，即 access token 的 `aud`）、一个 Permission `orqestra:admin`，以及 Role，如 `admin`（带该 Permission）和 `member`（不带）。
2. 创建一个 Web Application：`client_secret_basic`，开启 refresh token，redirect URI 为 `{ORQESTRA_URL}/auth/callback`，post logout redirect URI 为 `{ORQESTRA_URL}`，默认 API 选上面那个，并开启 `requireRole`，只让在该 API 上有 Role 的 User 登录。
3. 给 User 分配 Role。

从 better-auth 版本升级：先备份数据库，再 `pnpm db:migrate`。用 Polaris 登录过的 User 的对话会迁移到其 Polaris `sub`；只用密码登录的用户的对话会保留但隐藏，需要手动把 `user_id` 改为对应的 `sub`。

### 配置 Provider 与 Model

Admin 在 `/console/providers` 里从目录（pi 内置的 Provider 列表）选择 Provider，填写 API Key 和 `baseUrl`（默认填好目录中的地址，需要时改成自己的端点），再勾选要启用的 Model。保存后 web 和 worker 自动重新加载，无需重启；正在进行的 Run 不受影响。

### 配置 Search 与 Scrape

Agent 可以调用 Search（搜索网页）和 Scrape（读取一个网页，返回 Markdown）两个 Tool，由外部的 Search Provider（Tavily、Firecrawl、DeepSeek）提供。Admin 在 `/console/search` 添加 Search Provider 并填写 API Key（与 Provider 一样加密保存、只写不读）和 `baseUrl`（默认填好官方地址；自部署的 Firecrawl 或经过反向代理时改成自己的地址），再分别为 Search 和 Scrape 选一个。没有可用 Search Provider 的 Tool 不可用，Agent 照常运行但不带它。

### 配置 Sandbox Provider（orrery）

Skill 的脚本在 [orrery](https://github.com/zibyn/orrery) 的 Sandbox 里执行。Admin 在 `/console/sandbox` 填写 orrery 的 API 地址（不带 `/api/v1`）、API Token（加密保存、只写不读）、Snapshot（可选，留空用 orrery 默认的 Platform Snapshot），以及每个 Sandbox 的 CPU 和内存（默认 2 CPU、2 GiB）。最多配置一个；没有配置时所有 Skill 都不可用。保存时会用该 Token 请求一次 orrery 的 `GET /api/v1/users/me`，失败时显示原因（无法连接、Token 无效等），配置照常保存。所有 User 的 Sandbox 都在这个 Token 所属的 orrery User 下运行。

**签发 API Token**：用一个专门给 Orqestra 用的 orrery User 登录 CLI，再签发一枚 `user` scope 的 Token（`read_only` 不能创建 Sandbox）。明文只显示这一次，形如 `orr_<id>_<secret>`：

```bash
orrery --api-url https://orrery.example.com login --username orqestra
orrery token create --name orqestra --scope user
```

**构建推荐的 Snapshot**：Skill 常用 Python 3（pypdf、openpyxl、python-docx、pandas）和 Node。用同一个 orrery User 构建（Snapshot 名先在调用方自己的 Snapshot 里找，再找平台的），然后把名字（如 `orqestra-skills`）填进 Snapshot：

```dockerfile
# Dockerfile
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pypdf openpyxl python-docx pandas
```

```bash
orrery snapshot build orqestra-skills -f Dockerfile
```

再次运行同一条命令即生成新版本，orrery 构建成功后自动把 current 指向它；新建的 Sandbox 使用 current 版本。

### 添加 Agent

Admin 在 `/console/agents` 新建、编辑、删除 Agent，保存后 web 和 worker 自动重新加载，正在进行的 Run 不受影响。数据库里没有任何 Agent 时会自动写入 General。

- id 新建时由名称生成，可手动修改，创建后不可改。
- Models 不选表示所有已启用的 Model；引用了未启用或已不存在的 Model 只会警告，一个 Model 都不剩的 Agent 不可用。
- Tools 全选表示所有 Tool（包括以后新增的）。
- 恰好一个默认 Agent，且必须是用户可选的；默认 Agent 不能删除。删除 Agent 后它的对话变为只读。
- 关闭“用户可选”的 Agent 只作为子智能体（Subagent）模板。Agent 可通过 `subagent` Tool 把任务交给 Subagent，Subagent 从空白上下文开始，只把最终结果交回。

## 发布

推送 `v*` tag 会触发 [Release workflow](.github/workflows/release.yml)：构建并推送 web 与 worker 镜像到 GHCR，并创建 GitHub Release。

```bash
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

## 贡献

Issue 和 Pull Request 请提交到 [zibyn/orqestra](https://github.com/zibyn/orqestra/issues)。提交前运行 `pnpm check` 和 `pnpm test`。
