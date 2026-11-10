# BullMQ Postgres backend 的 Job Scheduler 能力

> 调研日期：2026-11-10。对应 issue #54（map #52）。
>
> 一手来源是仓库里装的 `bullmq@6.5.0`（`node_modules/.pnpm/bullmq@6.5.0_ioredis@6.0.0_pg@8.23.1/node_modules/bullmq`，下文写作 `bullmq/`）。npm 包里只有编译产物，没有 docs，所以直接读 `dist/esm` 下的 JS 和 SQL。Postgres 端的 SQL 在构建时内联进 `dist/esm/postgres/sql-scripts.js`（源头是 `src/postgres/migrations/*.sql` 和 `src/postgres/commands/*.sql`）。下文的 `0001_schema.sql:N` / `0002_functions.sql:N` 指从 `SQL_MIGRATIONS` 里取出的对应文件的行号。
>
> 标「实测」的结论来自一个一次性脚本：连本地开发库 `orqestra-pg`，在临时 schema `bullmq_research_tmp` 里跑（`migrate: true`），跑完 `drop schema ... cascade`。脚本没有提交。标「推断」的结论是我读代码得出的，没有实测。

## 结论

**支持。** v6.5 的 Postgres backend 完整实现了 Job Scheduler：`upsertJobScheduler`、`getJobScheduler`、`getJobSchedulers`、`getJobSchedulersCount`、`removeJobScheduler` 都有对应的 SQL 函数，用的是和 Redis 相同的 `JobScheduler` 类（`classes/job-scheduler.js`），Postgres 只换掉存储层。所以**不需要自己写替代方案**，直接用 BullMQ 的 Job Scheduler 即可。需要注意的是语义上的几个坑（见第 3 节），尤其是：停机期间错过的触发**不会补跑**，最多晚跑一次；下一次触发在当前这次被取走时就创建，所以长任务会**重叠**。

| 能力 | Postgres backend | 出处 |
|---|---|---|
| cron（含 6 段秒级） | 支持 | `job-scheduler.js:107-112, 291-308`；实测 `*/2 * * * * *` |
| 固定间隔 `every` / `offset` | 支持，下次时间由数据库算 | `0002_functions.sql:1898-1934` |
| 时区 `tz` | 支持，交给 cron-parser | `job-scheduler.js:296`；`scheduler.tz` 列 `0001_schema.sql:321` |
| `startDate` / `endDate` / `limit` / `immediately` | 支持 | `job-scheduler.js:80-104`；`queue.js:243-246` |
| 一次性定时 | 不走 Scheduler，用普通 delayed job：`queue.add(name, data, { delay, jobId })` | 实测 |
| 停机补偿 | 不补跑；积压的那一个 delayed job 恢复后立即跑一次，之后从“现在”往后算 | 第 3.1 节，实测 |
| 多 worker 去重 | 同一次触发只会跑一次 | 第 3.2 节，实测 |
| 按 id 更新 | `upsertJobScheduler(sameId, ...)`，替换掉待执行的那个 job，保留迭代计数 | `0002_functions.sql:1937-2117`；实测 |
| 按 id 删除 | `removeJobScheduler(id)`，返回 `true`/`false` | `queue.js:349-352`；`0002_functions.sql:2223-2260`；实测 |
| 列出 | `getJobSchedulers(start, end, asc)` 按 next 排序，`getJobSchedulersCount()` | `0002_functions.sql` 中 `get_job_schedulers_range.sql`；实测 |
| 旧的 `repeat` repeatable job | v6 已移除（Redis 也一样），只剩 Job Scheduler | `job-scheduler.js:61-65` |

## 1. 实现方式

- **存储**：一张 `scheduler` 表，主键 `(queue, scheduler_id)`，存 `next_run_ms`、`pattern`、`every_ms`、`tz`、`start_date_ms`、`end_date_ms`、`limit_count`、`iteration_count`、`template_data`、`template_opts`、`offset_ms`，并按 `(queue, next_run_ms)` 建索引（`0001_schema.sql:314-335`）。表注释原话：“A scheduler is a job factory … on each upsert, produces the next delayed job `repeat:<schedulerId>:<nextMillis>`. For cron the caller computes nextMillis (JS cron-parser); for `every` the backend computes it”。
- **触发**：Scheduler 自己不会“醒来”。它每次只在 `job` 表里放**一个** delayed job，id 为 `repeat:<schedulerId>:<nextMillis>`（`job-scheduler.js:287-289`）。worker 每次 `move_to_active` 时，先把 `process_at_ms <= now` 的 delayed job 改成 waiting（`0002_functions.sql:209-224`），再用 `FOR UPDATE SKIP LOCKED` 领一个（`0002_functions.sql:280`）。worker 用 `LISTEN/NOTIFY` 加 `next_delay`（最早的 `process_at_ms`）决定阻塞多久，不轮询。
- **推进**：worker 取到一个带 `repeatJobKey` 的 job 后，在**开始处理前**调用 `upsertJobScheduler(..., { override: false, producerId: job.id })`（`worker.js:531-549`），也就是 SQL `update_job_scheduler_next_millis`，它把下一次的 delayed job 插进去（`0002_functions.sql:2121-2219`）。
- **cron 的下一次时间在 JS 里算**，用 `cron-parser` 的 `CronExpressionParser.parse(pattern, { ...opts, currentDate })`，`tz` 原样传入（`job-scheduler.js:291-308`）。`every` 的下一次时间在 SQL 函数 `scheduler_every_next_millis` 里算（`0002_functions.sql:1898-1934`）。
- 结论：**必须至少有一个 worker 在跑这个队列**，否则 delayed job 不会被提升，Scheduler 也不会推进。只有 Queue（生产者）是不够的。

## 2. API（与 Redis 相同）

```ts
await queue.upsertJobScheduler(
  "daily-digest",                                   // id；同 id 再调一次就是更新
  { pattern: "0 0 9 * * *", tz: "Asia/Shanghai" },  // 或 { every: 60_000 }，二选一
  { name: "digest", data: { ... }, opts: { attempts: 3 } },
);
await queue.getJobScheduler("daily-digest");   // { key, name, next, iterationCount, tz, pattern, template, ... }
await queue.getJobSchedulers(0, -1, true);      // 按 next 升序
await queue.getJobSchedulersCount();
await queue.removeJobScheduler("daily-digest"); // 存在返回 true，否则 false
```

- `pattern` 和 `every` 必须二选一，`immediately` 不能和 `startDate` 同用（`job-scheduler.js:74-82`）。`endDate` 早于现在时直接抛错 `End date must be greater than current timestamp`（`queue.js:243-246`，实测）。
- 实测 `getJobSchedulers()` 的返回：`[{"key":"cron-a","name":"tick","next":1794279840000,"iterationCount":1,"tz":"Asia/Shanghai","pattern":"*/2 * * * * *","offset":0,"template":{"data":{"x":1}}}]`。

## 3. 语义细节与坑

### 3.1 停机期间漏掉的触发：不补跑，最多晚跑一次

- 停机时 `job` 表里只有一个待执行的 delayed job（下一次）。worker 恢复后，这个过期 job 会被立即提升并执行一次。
- 执行它时 worker 计算下一次：`now = max(Date.now(), prevMillis)`，再从 `now` 往后找下一个 cron 时刻（`job-scheduler.js:101-112`）；`every` 则是 `floor(now/every)*every + every`（`0002_functions.sql:1923-1926`）。所以中间漏掉的那些时刻**全部跳过**。
- 实测：
  - `*/2 * * * * *` 的 cron，worker 停 6 秒：恢复后 1 秒内只跑了 1 次（`repeat:cron-c:…854000`，晚了 4.8 秒），没有补跑其余几次。
  - `every: 1000`，worker 停 5 秒：恢复后跑了积压的 1 次，下一次直接对齐到当前时间之后。
- 如果业务需要“补跑”或者“过期太久就丢弃”，只能在处理函数里自己判断：cron 的 job 带有 `job.opts.prevMillis`（计划时间），`job.id` 末尾也是计划时间的毫秒数（`job-scheduler.js:182, 288`）。推断：`every` 的 job 在实测中 `opts.prevMillis` 为空（下一次时间由 SQL 算），只能从 id 解析。

### 3.2 多 worker 去重：同一次触发只跑一次

- 每次触发的 job id 是确定的 `repeat:<id>:<millis>`，`job` 表主键是 `(queue, id)`。
- 领取用 `FOR UPDATE SKIP LOCKED`，一个 job 只会被一个 worker 拿到。
- 推进时有两道防线：只有“当前这次”的 job（`producerId === 'repeat:<id>:<next_run_ms>'`）才能推进 Scheduler；如果下一次的 job 已经存在，就发 `duplicated` 事件并返回（`0002_functions.sql:2167-2182`），插入也是 `ON CONFLICT DO NOTHING`。
- 实测：两个 worker、每 2 秒一次的 cron，跑 7 秒，共 4 次执行、4 个不同 id，没有重复。
- 推断（未实测）：`update_job_scheduler_next_millis` 没有显式锁 `scheduler` 行，去重靠的是上面的 id 检查和主键约束。两个进程**同时**对同一 id 做 `upsertJobScheduler` 时（比如多个 worker 启动时都去注册），极端情况下可能报 `scheduler job id collision`（`BM001`/`-10`，`0002_functions.sql:2019-2037`）。启动时注册建议吞掉这个错误，或者只在一个地方注册（比如 api 在配置变更时注册）。

### 3.3 下一次在“开始处理”时就创建 → 长任务会重叠

- 推进发生在 `nextJobFromJobData`，也就是 job 刚被领取、还没执行时（`worker.js:519-560`）。所以 job 执行得比间隔还久时，下一次照常触发，会和上一次**并发**执行（受 worker `concurrency` 限制）。
- 对 orqestra 来说，如果一个定时任务是“启动一个 Agent Run”，处理函数应当只负责投递（比如写 inbox / 调 `enqueue`），由现有的 Run 机制保证同一个 Conversation 不重复跑，而不是在 scheduler job 里直接跑完整个 Run。
- 推断：job 失败不影响后续触发，因为下一次在执行前已经排好；失败重试走模板里的 `attempts`/`backoff`。

### 3.4 更新与删除

- 更新：同 id 再调 `upsertJobScheduler`（`override: true`），SQL 删掉旧的、仍处于 delayed/waiting 的下一次 job，按新的规则插入新 job，`iteration_count` 保留（`0002_functions.sql:2004-2013, 2041-2062`）。实测把 `*/2 * * * * *`+上海时区改成 `0 0 3 * * *`+纽约时区，delayed 列表里只剩一个 `repeat:cron-a:1794297600000`，`iterationCount` 从 1 增长到 5 后保留。
- 删除：只删 Scheduler 行和它**仍处于 delayed** 的下一次 job；已经提升为 waiting 或正在执行的那一次不会被删（`0002_functions.sql:2234-2258`），这和 Redis 一致。
- 注意：`queue.removeJobScheduler` 返回的是 `!removed`（`queue.js:349-352`），SQL 返回 0 表示删除成功，所以最终结果是删除成功时返回 `true`。实测：第一次删除返回 `true`，第二次返回 `false`。

### 3.5 时区

- `tz` 存进表里，计算时传给 cron-parser（`job-scheduler.js:296`）。下一次时间用的是**执行 `upsertJobScheduler` 那个 Node 进程的时钟**（`Date.now()`，`job-scheduler.js:96`），不是数据库的 `now()`。多台机器部署时需要时钟同步。
- 夏令时切换的行为取决于 cron-parser，本次没有验证。

### 3.6 一次性定时（某个时间点跑一次）

- Scheduler 必须有 `pattern` 或 `every`，不适合一次性任务。用普通 delayed job：`queue.add(name, data, { delay: at - Date.now(), jobId })`。
  - 同一个 `jobId` 再 add 会被忽略（实测：同一 `jobId` 添加两次，只执行 1 次），可以借此做幂等。
  - 查看：`queue.getDelayed()`；改时间：`job.changeDelay(ms)`（有 `change_delay` SQL）；取消：`queue.remove(jobId)` / `job.remove()`。
  - 和 Scheduler 一样不会补跑，worker 恢复后立即执行一次。
- 也可以用 `every` 加 `limit: 1` 加 `startDate` 硬凑，但没有必要。

## 4. 与 Redis backend 的差异

- 在 Scheduler 这部分没有找到功能缺口。Postgres backend 只有三个 `notImplemented` 操作：`paginate`、`removeDeprecatedPriorityKey`、`trimEvents`（`postgres/postgres-queue-backend.js:86-88, 1425, 1509, 1512`），都和调度无关。
- 实现差异：`every` 的下一次时间由 SQL 计算（`0002_functions.sql:1898`），所以自定义的 `settings.repeatStrategy` 只对 cron 生效（`job-scheduler.js:69-70, 107-108`）；Redis 下 `every` 是在 Lua 里算的，推断两者行为一致（SQL 注释写的是 “Mirror of the Lua getJobSchedulerEveryNextMillis”）。
- 运行前提：schema 必须先迁移。Queue 端（`packages/conversations/src/runs.ts` 的 `newQueue`）没有传 `migrate`；如果 worker 还没启动，直接用它注册 Scheduler 会报 `SchemaMigrationRequiredError`（实测，临时 schema 不带 `migrate: true` 时就报了这个错）。worker 的连接配置带了 `migrate: true`（`packages/conversations/src/serve.ts:544`），所以要么先启动 worker，要么让注册 Scheduler 的 Queue 也带上 `migrate: true`。

## 5. 对 orqestra 的建议（推断）

1. 直接用 BullMQ Job Scheduler，不需要自建轮询表。
2. 新建一个独立的队列（比如 `scheduled-triggers`），不要放进 `agent-runs`/`subagent-runs`：那两个 worker 配了 `maxStalledCount: 0`，而且 job 数据是 `{ conversationId }`（`serve.ts:535-552`、`runs.ts:96-121`）。scheduler job 的处理函数只做“投递”（写 inbox，再走现有的 start/enqueue 逻辑），这样就不会重叠，也能复用现有的去重逻辑。
3. Scheduler id 用业务 id（比如 `schedule:<scheduleId>`），这样更新、删除、列表都能按 id 做；如果需要在 UI 展示，自己的表可以只存配置，执行状态以 `getJobScheduler(id).next` 为准，或者干脆以我们的表为准，在每次修改后同步调用 `upsertJobScheduler`/`removeJobScheduler`。
4. 需要“补跑漏掉的触发”的场景只能自己做：在处理函数里比较 `prevMillis`（或 id 里的时间戳）和当前时间来决定。

## 未验证

- 夏令时切换时 cron 的表现（cron-parser 的行为）。
- 多个进程同时对同一 id 做 `upsertJobScheduler` 的竞争（3.2 最后一条）。
- 数据库和各 worker 时钟不一致带来的影响。
