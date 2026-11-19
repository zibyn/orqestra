# integrations、tools、mcp 边界整理计划

目标：让 integrations、tools、mcp 三个包各自只做 ADR 0010、0018 和 GLOSSARY 分给它的事，零行为变化。

状态：形状 A 已完成，PR1 是 #176，PR2 是 #177，PR3 是 #178，都已合并。PR2 的页面检查按通过条件核对，没有和 trunk 截图对比。

## 现状（/how 结论）

依赖图，与 `scripts/layers.mjs` 一致，`pnpm check` 在 trunk 上通过（已运行）：

```
db (L0) ← integrations (L1) ← tools (L2)
db (L0) ← mcp (L2)            mcp 不依赖 integrations
agents (L3) → tools, mcp
conversations (L4) → integrations, tools, mcp
api, worker (L5) → 三者全部；web → tools/shared
```

职责与文档对得上的部分：
- integrations 有每个外部系统一个目录、`ports.ts`、Integration Installation（`installation.ts`）、Integration Account（`accounts.ts`）和 WorkSource 列表（`sources.ts`）。队列和长连接放在这里，是 ADR 0018 明确决定的（"Integration Installation 是配置，和客户端放在一起"）。
- tools 有 Search、Scrape、Parse 三个内置 Tool，Sandbox Provider、Search Provider、Document Parser 的配置（`live.ts`），以及 Sandbox 的就绪和执行（`sandbox.ts`）。
- mcp 有协议客户端、Connection OAuth、Git Host 字段和 Background Call 的轮询与取消。这符合 ADR 0016 和 0018（"MCP 是协议，不是一个系统"）。

偏离文档、且能零行为变化修正的地方：
1. ADR 0018 第 49 行写"conversations' `SOURCES`"。实际列表是 `packages/integrations/src/sources.ts` 的 `sources`，被 conversations、api、worker 共用。属于文档过时。
2. 厂商知识放在 tools，没有放在 integrations。`tools/src/shared.ts` 存着三个 Search Provider 的官方 baseUrl、`MINERU_URL` 和 `isMineruNet`。`integrations/src/mineru/index.ts:7` 还有一份私有的 `isMineruNet` 副本。ADR 0018 要求厂商怎么连接只写在 integrations。原因是 web 只能 import `/shared` 入口，而 integrations 没有这个入口（推断）。
3. tools 知道 MCP Server 的存在。`ToolServices.mcpServers: Record<string, unknown>`（`tools/src/index.ts:36`）只为让 `availableTools` 拼出 `mcp:<id>`，类型写成 `unknown` 是为了绕开同层依赖。真正同时依赖 tools 和 mcp 的最低包是 agents（L3），唯一的生产调用方 `agents/src/live.ts:103` 也在那里。ADR 0010 规定跨能力的操作放在依赖所有相关能力的最低那个包里。

查过但不在本计划里的事，各附理由：
- 两个 `callbackUrl` 不是重复。integrations 的按 WorkSource 生成路径，mcp 的是 Connection 的路径。
- 两个 `Fetch` 类型签名一样。合并要新增 mcp → integrations 这条依赖，只为一个类型别名，不值得。
- mcp 自己解析 `mcp:` 前缀，没有用 `mcpServerOf`。改成共用要么 tools 依赖 mcp（同层，禁止），要么把 `ToolRef` 移到 mcp，会把 tools 的 Tool 名单拆到两处。维持现状。
- db 的传法不一致：`createTools(db)` 由调用方传入，`installation.ts`、`accounts.ts`、`mcp/connections.ts` 用模块单例。统一会改动所有调用方和测试的启动方式，属于另一件事。
- `apps/worker/src/runtime/sandbox.ts` 里定义了 `read` 和 `bash` 两个 Tool，以及 Git 凭据注入。它不在这三个包里，而且同目录的 `tools.ts` 里还有 timer、subagent、question 等 Tool。只移 sandbox 会让 Run 的 Tool 分散到两处。要不要把整个 `runtime/` 下沉，是单独的决定，见文末的开放问题。

## 两种目标形状

### 形状 A：保持分层，把偏离的三处移回 ADR 指定的位置（推荐）

```
integrations (L1)  客户端 · ports · Installation · Account · sources · 新增 /shared（厂商常量，浏览器可用）
tools (L2)         内置 Tool · 三种 Provider 的配置 · Sandbox 就绪与执行；不再出现 mcpServers
mcp (L2)           不变
agents (L3)        availableTools = 内置 Tool + 每个 MCP Server 的 mcp:<id>
```

改动：一处 ADR 文字，一个新的 `/shared` 入口，一个函数签名收窄。不需要新包，不需要新 ADR，`layers.mjs` 的层表不变。

### 形状 B：integrations 只剩无状态客户端，配置和服务上移到新包

```
integrations (L1)  ports · 各系统客户端（纯请求与解析，不依赖 db 和 bullmq）
worksources (L2)   Installation · Account · sources · <kind>-events/-tokens/-posts 队列 · 长连接与 advisory lock
tools, mcp (L2)    同形状 A
```

好处：L1 真的只剩客户端，单测不需要 Postgres，`process.env.DATABASE_URL` 不再在 L1 模块加载时读取。代价：新包、新 ADR（推翻 ADR 0018 已接受的"Installation 和客户端放一起"）、`layers.mjs` 层表、conversations/api/worker 的 import、CI 镜像打包都要改，约 1200 行和两个 db 测试文件要搬家。

### 推荐 A

- Laziness Protocol 和 Subtract Before You Add 的判断：B 重新决定一个已接受的 ADR，却没有新需求推动。A 用三个小 PR 消除了文档与代码的全部偏离。
- B 的收益（不依赖 Postgres 的单测）今天可以拿到，不用搬家。adapter 测试已经用 `fakeChannel`、`memoryOrrery` 跑，不依赖 db。
- 以后如果 WorkSource 的服务逻辑长到需要独立发版或独立测试，再按 B 做，A 不会挡路。

## PR 列表与依赖

| PR | 内容 | 依赖 | 可改文件 |
|---|---|---|---|
| PR1 | ADR 0018 的 `SOURCES` 文字更正 | trunk | `docs/adr/0018-*.md` |
| PR2 | 厂商常量移到 `@orqestra/integrations/shared` | trunk | `packages/integrations/{package.json,src/shared.ts,src/mineru/index.ts}`, `packages/tools/src/{shared,index,live}.ts` 及其测试, `apps/web/package.json`, `apps/web/src/routes/console/{search,parse}.tsx`, `scripts/layers.mjs`（selfCheck 一条） |
| PR3 | tools 不再知道 MCP Server，`availableTools` 由 agents 组合 | PR2 合并后（两者都改 `tools/src/index.ts`） | `packages/tools/src/{index,available.test,live.db.test}.ts`, `packages/agents/src/live.ts` 及其测试, `apps/api/src/capabilities.db.test.ts` |

PR1 与 PR2 互不依赖。三个 PR 都不改交互，不需要等审阅后才合并。性能项对三者都不适用：没有运行时代码路径变化，只有 import 位置和类型。

## PR1：ADR 0018 文字更正

- [x] 依赖：trunk
- [x] 文件：`docs/adr/0018-integrations-hold-every-outside-systems-client.md`
- [x] 改动：第 49 行"an entry in conversations' `SOURCES`"改为"an entry in `sources` (`packages/integrations/src/sources.ts`)"。
- [x] 结果：ADR 描述的新增 WorkSource 步骤与代码一致。
- [x] 验证
  - [x] `rg -n "SOURCES" docs GLOSSARY.md` 无结果
  - [x] `pnpm check` 通过
  - [x] 实况：不适用，只改文档
  - [x] 性能：不适用

## PR2：厂商常量移到 `@orqestra/integrations/shared`

- [x] 依赖：trunk
- [x] 改动
  - [x] 新建 `packages/integrations/src/shared.ts`，文件头注明不得有 Node import。内容是从 `tools/src/shared.ts` 原样移过来的 `searchProviders`、`SearchProviderId`、`MINERU_URL`、`isMineruNet`。
  - [x] `packages/integrations/package.json` 的 exports 加 `"./shared"`。
  - [x] `mineru/index.ts` 删掉私有的 `isMineruNet`，改为从 `../shared.ts` import。
  - [x] `tools/src/shared.ts` 删掉这四个导出。`searchProviderId` 这个 zod enum 留在 tools，改为从 `@orqestra/integrations/shared` 读 `searchProviders`。不保留 re-export（Migrate Callers Then Delete Legacy APIs）。
  - [x] 调用方全部改为从新入口 import：web 的 `search.tsx`、`parse.tsx`，tools 的 `index.ts`、`live.ts` 和测试。`apps/web/package.json` 加 `@orqestra/integrations: workspace:*`。
  - [x] `scripts/layers.mjs` 的 selfCheck：在 web 合法 import 的样例里加 `@orqestra/integrations/shared`。现有正则已经放行，这一条用来锁住。
- [x] 结果：每个厂商的地址和判断规则在仓库里只写一次，位置在 integrations。
- [x] 验证
  - [x] `rg -n "isMineruNet|MINERU_URL|searchProviders\b" packages apps --glob '!**/node_modules/**'`：定义只出现在 `integrations/src/shared.ts`
  - [x] `rg -n "from \"node:" packages/integrations/src/shared.ts` 无结果
  - [x] 在 integrations、tools、api、web 各自目录下运行 `pnpm exec tsc --noEmit`，全部通过
  - [x] `pnpm check` 通过
  - [x] `pnpm --filter @orqestra/tools test`、`pnpm --filter @orqestra/integrations test`（包括 mineru 的 12 个用例）通过，测试库按 test-db-in-dev-pg 的约定使用 `orqestra_test`
  - [x] `pnpm build` 通过，证明 web 打包没有拉进 Node 模块
  - [x] 实况（verify-orqestra，以 Admin 身份）
    - `/console/search`：未配置时列出 Tavily、Firecrawl、DeepSeek。选中 Tavily 后，地址默认填 `https://api.tavily.com`。通过条件：三个名字和三个默认地址与 trunk 截图一致。
    - `/console/parse`：新建时地址默认 `https://mineru.net`，key 必填。把地址改成 `http://mineru.local:8000` 后 key 变成选填。通过条件：两个状态与 trunk 一致。
  - [x] 性能：不适用

## PR3：tools 不再知道 MCP Server

- [x] 依赖：PR2 已合并
- [x] 改动
  - [x] `tools/src/index.ts`：`ToolServices` 删除 `mcpServers`，`availableTools` 只返回 `toolNames` 中可用的那些。
  - [x] `agents/src/live.ts:103`：改为 `[...availableTools(usable), ...Object.keys(usable.mcpServers).map(mcpToolRef)]`。顺序和 trunk 一样，内置 Tool 在前。`mcpToolRef` 仍然来自 `@orqestra/tools/shared`。
  - [x] `agents/src/live.ts:45` 的类型从 `ToolServices & {…}` 改成显式写出 `mcpServers`。
  - [x] 测试
    - `tools/src/available.test.ts` 只断言内置 Tool。
    - 原来"MCP Server 列入 `mcp:<id>`"的断言移到 agents 的测试，断言 Agents 快照对外的 `availableTools`，即用户能看到的那份名单。
    - `apps/api/src/capabilities.db.test.ts:301` 改为断言 agents 快照里的 `availableTools` 不含 `mcp:docs`，否则这条断言会变成恒真。
- [x] 结果：tools 里不再出现 `mcpServers` 和 `unknown` 占位类型。MCP Server 怎么进入一个 Agent 的可选 Tool，只由 agents 决定。
- [x] 验证
  - [x] `rg -n "mcpServers" packages/tools/src` 无结果
  - [x] 在 tools、agents、api、worker 各自目录下运行 `pnpm exec tsc --noEmit`，全部通过。worker 的 `toolbox.ts` 用的是 `ToolServices & McpServices`，要确认它仍然成立
  - [x] `pnpm check` 通过
  - [x] `pnpm --filter @orqestra/tools test`、`pnpm --filter @orqestra/agents test`、`pnpm --filter @orqestra/api test`、`pnpm --filter @orqestra/worker test` 通过
  - [x] 实况（verify-orqestra）：配置一个 Search Provider 和一个 MCP Server，打开 Agent Definition 编辑页。通过条件：可选 Tool 列表为 search、scrape，然后是该 MCP Server，顺序与 trunk 一致。删除这个 MCP Server 后，它从列表中消失。
  - [x] 性能：不适用

## 开放问题（不阻塞本计划）

`apps/worker/src/runtime/` 约 1800 行非测试代码，是 Run 的执行器。它定义 Run 用的 Tool（sandbox、timer、subagent、question）、压缩和记忆。ADR 0010 说 worker 只做组装。要把它下沉，只有 conversations 依赖了所需的全部包。这件事比本计划大，应当单独写 ADR 决定。
