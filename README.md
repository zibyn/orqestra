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

- `packages/config` — the Catalog (pi's built-in Providers and Models), Agent Definitions from `config/`, and the Providers/Models Admins configure in the database; used by both web and worker.

Env vars live in the root `.env.local`, shared by all packages. `ORQESTRA_ENCRYPTION_KEY` is required by web and worker: it encrypts Provider API keys in the database (`openssl rand -base64 32`). Changing it makes stored keys unreadable; re-enter them in `/console/providers`.

## 如何配置 Provider 与 Model

Admin 在 `/console/providers` 里从目录（pi 内置的 Provider 列表）选择 Provider，填写 API Key 和可选的 `baseUrl`，再勾选要启用的 Model。保存后 web 和 worker 自动重新加载，无需重启；正在进行的 Run 不受影响。

## 如何添加一个 Agent

配置目录默认是仓库根目录的 `config/`，可用 `ORQESTRA_CONFIG_DIR` 指向别处。web 和 worker 在启动时加载 Agent Definition，修改后需要重启；文件有误时两边都会启动失败，并在报错中给出文件和字段。引用了未启用或已不存在的 Model 只会警告（`/console/agents` 中可见），一个 Model 都不剩的 Agent 不可用。

1. 确认要用的 Model 已在 `/console/providers` 中启用。
2. 新建 `config/agents/<id>.md`，文件名就是 Agent 的 id。frontmatter 之后的正文是指令（system prompt）：

   ```markdown
   ---
   name: Translator
   description: Translates between Chinese and English.
   models: [deepseek/deepseek-flash]   # 可选，不写则所有已启用的 Model 都可用
   defaultModel: deepseek/deepseek-flash # 可选，默认 models[0]，再退到 ORQESTRA_DEFAULT_MODEL；不可用时退回剩下的第一个
   thinking: { default: low, allowed: [off, low, high] } # 可选，不写 allowed 则允许模型支持的所有档位
   compaction: { reserveTokens: 16384, keepRecentTokens: 20000 } # 可选，覆盖 pi 默认值
   ---
   You translate the user's text between Chinese and English.
   ```

3. 所有 Agent 中必须恰好有一个写 `default: true`（新建 Conversation 时默认选中）。
4. 重启 web 和 worker，在 `/console/agents` 查看结果。

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





## Setting up Better Auth

1. Generate and set the `BETTER_AUTH_SECRET` environment variable in your `.env.local`:

   ```bash
   pnpm dlx @better-auth/cli secret
   ```

2. Visit the [Better Auth documentation](https://www.better-auth.com) to unlock the full potential of authentication in your app.

### Adding a Database (Optional)

Better Auth can work in stateless mode, but to persist user data, add a database:

```typescript
// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  // ... rest of config
});
```

Then run migrations:

```bash
pnpm dlx @better-auth/cli migrate
```



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
