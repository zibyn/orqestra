// The Agent Definitions and the prompts the smoke test sends: a lead and its team, two tasks it delegates and one it may answer itself.

export type Role = "lead" | "team";

const member = (name: string, description: string, instructions: string) => ({
	name,
	description,
	instructions,
	tools: [],
	pickable: false,
});

export const LEAD = "tech-lead";

export const AGENTS: {
	id: string;
	role: Role;
	definition: Record<string, unknown>;
}[] = [
	{
		id: LEAD,
		role: "lead",
		definition: {
			name: "技术负责人",
			description: "协调安全、性能和文档评审，把各方结论汇总给你。",
			instructions: [
				"你是团队的技术负责人。用户会把代码、技术方案或上线前的准备工作交给你。",
				"",
				"你的团队成员有：安全评审、性能评审、技术文档工程师。需要专门视角的工作，交给对应的成员，每人一份完整、独立的任务说明；他们的结果回来后，由你核对、去重、排出优先级，整合成一份给用户的答复。简单的问题可以直接回答。",
				"",
				"用中文回答，结论先行。",
			].join("\n"),
			tools: [],
			pickable: true,
		},
	},
	{
		id: "security-reviewer",
		role: "team",
		definition: member(
			"安全评审",
			"审查代码和方案中的安全问题：注入、鉴权、敏感信息泄露、依赖风险，给出修复建议。",
			"你是应用安全工程师。逐条列出发现的问题，每条写明位置、风险等级（高/中/低）、可被如何利用、具体修复方式。没有把握的标注为待确认。",
		),
	},
	{
		id: "perf-reviewer",
		role: "team",
		definition: member(
			"性能评审",
			"评估代码和方案的性能与容量风险：数据库查询、并发、资源占用，并设计压测方案。",
			"你是性能工程师。指出瓶颈及其量级估算，给出改法；需要时给出压测场景、指标和通过标准。",
		),
	},
	{
		id: "tech-writer",
		role: "team",
		definition: member(
			"技术文档工程师",
			"编写和审阅技术文档：接口说明、使用指南、代码注释和变更说明。",
			"你是技术文档工程师。写给工程师读的文档：准确、完整、有示例，缺失的信息明确列为待补充，不要编造。",
		),
	},
];

const CODE = `\`\`\`ts
import express from "express";
import { execSync } from "node:child_process";
import { pool } from "./db";

const app = express();
app.use(express.json());

// 按用户名搜索订单，带上每个订单的商品
app.get("/orders/search", async (req, res) => {
  const name = req.query.name;
  const users = await pool.query(\`SELECT * FROM users WHERE name LIKE '%\${name}%'\`);
  const result = [];
  for (const u of users.rows) {
    const orders = await pool.query(\`SELECT * FROM orders WHERE user_id = \${u.id}\`);
    for (const o of orders.rows) {
      o.items = (await pool.query(\`SELECT * FROM order_items WHERE order_id = \${o.id}\`)).rows;
      result.push(o);
    }
  }
  res.json({ ok: true, data: result, debug: { env: process.env } });
});

// 导出某个订单为 CSV
app.post("/orders/:id/export", (req, res) => {
  const file = \`/tmp/exports/\${req.params.id}.csv\`;
  execSync(\`psql -c "\\\\copy (select * from orders where id=\${req.params.id}) to '\${file}' csv"\`);
  res.download(file);
});

app.listen(3000);
\`\`\``;

/** One prompt per task, as a User would type it; `delegates`: the lead is expected to start Subagents for it. */
export const TASKS = [
	{
		id: "review",
		delegates: true,
		prompt: `下面是订单服务里新加的两个接口，明天要合进主干。帮我从安全、性能、文档三个角度分别仔细过一遍，最后汇总成一份结论，按严重程度排一下先改什么。\n\n${CODE}`,
	},
	{
		id: "writeup",
		delegates: true,
		prompt:
			"我们下周要上线一个“批量导入用户”的接口：管理员上传一个最多 10 万行的 CSV（字段：邮箱、姓名、手机号、部门），后台解析后写进 users 表，接口返回导入结果。帮我准备三样东西：1）上线前要过的安全检查清单；2）性能方面的风险和压测方案；3）一份给前端同学看的接口说明（请求、响应、错误码）。最后把三份整理到一起发我。",
	},
	{
		id: "optional",
		delegates: false,
		prompt:
			"我们用这个正则校验邮箱：`^([a-zA-Z0-9_.+-]+)+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$`，线上偶尔会把一个 CPU 核打满，是什么原因？怎么改比较稳？",
	},
] as const;
