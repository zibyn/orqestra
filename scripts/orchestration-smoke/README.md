# Subagent 编排冒烟测试

用真实 Model 跑一个负责人 Agent（`tech-lead`）和它的三个成员模板，确认编排没有坏：每棵树都能结束，子任务都完成，没有调用被拒，没有模型错误，没有子任务交回空结果。它只检查数据库里能直接看到的东西，**不评判答复的质量**。改了 Subagent、Notification、Run 生命周期、Sandbox 工具之后跑一遍。

## 运行

先确认 3000、3001、55432、59000 端口空闲，开发库 `orqestra-pg` 里有 `deepseek` Provider。在仓库根目录执行：

```bash
bun scripts/orchestration-smoke/smoke.ts
```

默认三个任务各跑 1 次，同时跑，每次最多等 20 分钟：

- `review`：评审一段代码，负责人应当派出子任务；
- `writeup`：准备三份文档，负责人应当派出子任务；
- `optional`：一个可以直接回答的问题。

脚本会：

1. 没有 verify 实例时，用 `.claude/skills/verify-orqestra/scripts/verify.sh up` 起一个，结束时关掉。已有实例时沿用，不会关掉它。
2. 从开发库读出 `deepseek` 的 key，在内存里解密，经 api 配进实例。key 不打印，也不写入文件。
3. 建好 `fixtures.ts` 里的 Agent Definition，每次运行开一个新的 Incognito 会话，消息走网页用的同一个 `POST /api/messages`。
4. 把每次运行的检查结果写进 `results/<时间戳>/`：`runs.json` 是每次运行的记录，`summary.md` 是汇总表。有任何一项判为失败，脚本以退出码 1 结束。

判失败的情况：会话失败或卡住；空闲却没有答复；子任务失败或被截断；`subagent` 工具的调用被拒；有模型错误；子任务交回了空结果。

只提示、不判失败的情况：子任务被父 Agent 停掉；应当派子任务却没有派；出现嵌套；交回的内容不到 200 个字符；有 bash 命令超时。

## 选项

- `SANDBOX=1`：把开发库里的 Sandbox Provider（orrery）也配进实例，token 同样只在内存里解密。结束时脚本会删除它开过的会话，Sandbox 跟着删掉，因为那是 orrery 上的真实机器。删除失败时会打印出会话和 Sandbox 的 id，要到 orrery 上手动删。
- `KEY_FILE=<路径>`：改从这个文件读 key，用于新 key 还没存进开发库的时候。
- `RUNS`（默认 1）：每个任务跑几次。
- `PARALLEL`（默认 3）：同时跑几个顶层会话。同时跑的会话多，子任务也多，worker 的并发上限要跟着放宽：`WORKER_CONCURRENCY`、`SUBAGENT_CONCURRENCY`、`PROVIDER_CONCURRENCY`，默认都是 8。
- `TIMEOUT_MIN`（默认 20）：每次运行最多等几分钟。
- 如果 shell 里设置了 `HTTPS_PROXY`，而这个代理连不上 Provider，就会报 `Connection error.`。这时用 `env -u HTTPS_PROXY -u HTTP_PROXY` 启动。

## 为什么不评质量

这个目录原来是一个带盲评的"编排稳定性试验"，2026-11-20 审计后改成了冒烟测试。原来的设计有几处问题：

- 负责人的指令里直接写明了成员的名字，所以测不出派错。
- 任务一个 Model 也能完成，是指令要求负责人拆分。
- "遗漏"按评审列出的每一条来数，而好的汇总本来就该取舍。
- 没有标准答案。
- 每轮换一批评判，样本又小。
- 每轮之间同时变了代码、网络和评判。

站得住的只有直接数出来的那部分，这些检查保留在这里。当时的报告和评判材料留在 git 历史里（#181、#185、#188 之前的提交）。

要评汇总质量（#182），得另做一套：选真正需要拆分的任务，带上预埋问题的标准答案，固定评判，在同一轮里做改动前后的对照。
