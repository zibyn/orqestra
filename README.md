Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
pnpm install
pnpm dev
```

## Workspace layout

- `apps/web` — TanStack Start app (Node). Run shadcn/paraglide commands from here.
- `apps/worker` — BullMQ worker on the Postgres backend (Bun, uses `DATABASE_URL`; tables in the `bullmq` schema). `pnpm worker`.
- `packages/db` — Drizzle schema + client. `pnpm db:push` etc.
- `packages/conversations` — the Conversation lifecycle (Runs, Inbox, Subagents, Notifications); the only code that reads or writes those tables. The web app calls its User side; the worker serves Runs through it (`serveRuns`).

- `packages/config` — the Catalog (pi's built-in Providers and Models), and everything Admins configure in the database (Providers, Models, Search Providers, MCP Servers, the Sandbox Provider, Skills, Agent Definitions); used by both web and worker.

Env vars live in the root `.env.local`, shared by all packages. `ORQESTRA_ENCRYPTION_KEY` is required by web and worker: it encrypts Provider API keys in the database (`openssl rand -base64 32`). Changing it makes stored keys unreadable; re-enter them in `/console/providers`.

## 如何配置 Provider 与 Model

Admin 在 `/console/providers` 里从目录（pi 内置的 Provider 列表）选择 Provider，填写 API Key 和 `baseUrl`（默认填好目录中的地址，需要时改成自己的端点），再勾选要启用的 Model。保存后 web 和 worker 自动重新加载，无需重启；正在进行的 Run 不受影响。

## 如何配置 Search 与 Scrape

Agent 可以调用 Search（搜索网页）和 Scrape（读取一个网页，返回 Markdown）两个 Tool，由外部的 Search Provider（Tavily、Firecrawl、DeepSeek）提供。Admin 在 `/console/search` 添加 Search Provider 并填写 API Key（与 Provider 一样加密保存、只写不读）和 `baseUrl`（默认填好官方地址；自部署的 Firecrawl 或经过反向代理时改成自己的地址），再分别为 Search 和 Scrape 选一个。没有可用 Search Provider 的 Tool 不可用，Agent 照常运行但不带它。

## 如何配置 Sandbox Provider（orrery）

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

## 如何添加一个 Agent

Admin 在 `/console/agents` 新建、编辑、删除 Agent，保存后 web 和 worker 自动重新加载，正在进行的 Run 不受影响。数据库里没有任何 Agent 时会自动写入 General。

- id 新建时由名称生成，可手动修改，创建后不可改。
- Models 不选表示所有已启用的 Model；引用了未启用或已不存在的 Model 只会警告，一个 Model 都不剩的 Agent 不可用。
- Tools 全选表示所有 Tool（包括以后新增的）。
- 恰好一个默认 Agent，且必须是用户可选的；默认 Agent 不能删除。删除 Agent 后它的对话变为只读。
- 关闭“用户可选”的 Agent 只作为子智能体（Subagent）模板。Agent 可通过 `subagent` Tool 把任务交给 Subagent，Subagent 从空白上下文开始，只把最终结果交回。

# Building For Production

To build this application for production:

```bash
pnpm build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`

## Linting & Formatting

This project uses [Biome](https://biomejs.dev/) for linting and formatting. The following scripts are available:


```bash
pnpm lint
pnpm format
pnpm check
```


## Deploy with Nitro

This project uses Nitro as a generic server adapter, so it can run on any Node-compatible host.

```bash
npm run build
node dist/server/index.mjs
```

The build output is a self-contained Node server. To deploy, push the `dist/` directory to your host (Render, Fly.io, your own VPS, etc.) and run the server command above.

For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda, etc.) and tuning, see https://v3.nitro.build/deploy.


# Paraglide i18n

This add-on wires up ParaglideJS for localized routing and message formatting.

- Messages live in `project.inlang/messages`.
- URLs are localized through the Paraglide Vite plugin and router `rewrite` hooks.
- Run the dev server or build to regenerate the `src/paraglide` outputs.


## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpm dlx shadcn@latest add button
```


## T3Env

- You can use T3Env to add type safety to your environment variables.
- Add Environment variables to the `src/env.mjs` file.
- Use the environment variables in your code.

### Usage

```ts
import { env } from "#/env";

console.log(env.VITE_APP_TITLE);
```





## Sign-in with Polaris

Orqestra keeps no users of its own: Polaris owns the User pool and signs everyone in (`docs/adr/0003-polaris-owns-the-user-pool.md`). In Polaris' console:

1. Create an API for Orqestra (its identifier, e.g. `orqestra`, goes in `POLARIS_AUDIENCE`: the `aud` of the access tokens), a Permission `orqestra:admin`, and Roles such as `admin` (with that Permission) and `member` (without).
2. Create a Web Application: `client_secret_basic`, refresh tokens on, redirect URI `{ORQESTRA_URL}/auth/callback`, post logout redirect URI `{ORQESTRA_URL}`, default API the one above, and `requireRole` on so only Users with a Role at it can sign in.
3. Give Users their Role.

Then set in `.env.local`:

```bash
ORQESTRA_URL=https://orqestra.example.com
POLARIS_ISSUER=https://auth.example.com
POLARIS_CLIENT_ID=...
POLARIS_CLIENT_SECRET=...
POLARIS_AUDIENCE=orqestra
POLARIS_SECRET=$(openssl rand -base64 32)  # encrypts the session cookie; changing it signs everyone out
```

Upgrading from the better-auth version: back up the database, then `pnpm db:migrate`. Conversations of Users who had signed in with Polaris move to their Polaris `sub`; those of password-only users are kept but hidden until their `user_id` is set to the person's `sub` by hand.

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).



# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
