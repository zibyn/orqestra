# Subagent 编排稳定性试验

用真实 Model 测量当前的 Subagent 编排有多稳：一个可选的负责人 Agent（`tech-lead`），三个对口的团队成员模板，五个无关的干扰模板，三个任务各跑 5 次。所有数字从 verify 实例的数据库读出，不依赖 Agent 的自述。结论写在 `REPORT.md`。

## 运行

先确认 3000、3001、55432、59000 端口空闲，开发库 `orqestra-pg` 里有 `deepseek` Provider。然后在仓库根目录执行：

```bash
bun scripts/orchestration-trial/trial.ts
```

脚本会做这几件事：

1. 没有 verify 实例时，用 `.claude/skills/verify-orqestra/scripts/verify.sh up` 起一个，结束时 `down` 掉。已有实例时沿用，不会关掉它。
2. 从开发库读出 `deepseek` 的 API key，用 `.env.local` 的 `ORQESTRA_ENCRYPTION_KEY` 在内存里解密，经 api 配进 verify 实例。key 不打印，也不落盘。
3. 经 api 建好 `fixtures.ts` 里的 Agent Definition，把 `deepseek-flash` 设为默认 Model。
4. 按 review、writeup、optional 轮流发消息，每次一个新的 Incognito Conversation，和网页发消息走同一个 `POST /api/messages`。每次等整棵树空闲，最多 10 分钟。负责人向用户提问（`ask_user`）时记为 question。超时记为 stuck 并停掉。
5. 结果写进 `results/<时间戳>/`：`runs.json`（每次的原始记录）、`judge-packet-<n>.md`（给评判的匿名材料，每个运行序号一份）、`labels.json`（标签到 Conversation id 的对照，不给评判看）、`metrics.md`（统计表）。

如果 shell 里设置了 `HTTPS_PROXY`，而这个代理连不上 Provider，Run 会以 `Connection error.` 失败。这时先去掉代理再起实例：`env -u HTTPS_PROXY -u HTTP_PROXY .claude/skills/verify-orqestra/scripts/verify.sh up`。

`SANDBOX=1` 会把开发库里的 Sandbox Provider（orrery）也配进实例，token 同样只在内存里解密。这样 Agent 有 Sandbox，会通过 `/workspace` 交接文件。结束时脚本会删除它开过的每个会话，从而删掉对应的 Sandbox，这些 Sandbox 是 orrery 上的真实机器。所以 Sandbox 测评不能用 `recollect` 重做，测到的东西都在 `runs.json` 里。每次的设置写在 `setup.json`。

环境变量 `RUNS`（每个任务的次数，默认 5）、`ONLY`（只跑一个任务）、`TIMEOUT_MIN`（每次的超时，默认 10）可以调整规模。

## 评判

"提前声称""遗漏发现"和"错归属"要读文字才能判断，由看不到 Model 名的评判来做，每份材料一个评判：

1. 每个 `results/<时间戳>/judge-packet-<n>.md` 连同 `judge-rubric.md` 交给一个评判 Model，只给这两个文件。每份材料含每个任务各一次运行，约 10 万字。
2. 把它输出的 JSON 合并成一个数组，存为 `results/<时间戳>/judge.json`。
3. 重新生成统计表：`bun scripts/orchestration-trial/trial.ts report scripts/orchestration-trial/results/<时间戳>`。

`results/20261119-0527/judge-recheck.json` 是第 1、2 份材料的另一次独立评判，用来看评判之间差多少，`REPORT.md` 里有对照。

实例还开着时，`recollect <目录>` 会从数据库重新生成该目录的 `runs.json`、评判材料和统计表，用于修改统计口径之后。

## #180 之后重跑

在 `fixtures.ts` 的 `LEAD` 定义上加上 `subagents: ["security-reviewer", "perf-reviewer", "tech-writer"]`，三个成员加上 `subagents: []`，重跑同一条命令，再用同一份细则评判，把两次的 `metrics.md` 对照看。

改了 Subagent 工具描述、Notification 或 Limits 之后，也用这条命令对照。
