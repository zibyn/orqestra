#!/usr/bin/env bun
// Measures how stable today's Subagent orchestration is: a lead Agent, its team and some distractor templates,
// a real Model, organic prompts. Everything it reports is read from the verify instance's database.
//
//   bun scripts/orchestration-trial/trial.ts                 # setup + all runs + judge packet, into results/<stamp>/
//   bun scripts/orchestration-trial/trial.ts report <dir>    # metrics.md from <dir>/runs.json (+ judge.json)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SQL } from "bun";
import { decryptSecret, encryptionKey } from "../../packages/db/src/secret.ts";
import { AGENTS, LEAD, type Role, TASKS } from "./fixtures.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;
const VERIFY = `${ROOT}.claude/skills/verify-orqestra/scripts/verify.sh`;
const API = "http://127.0.0.1:3001/api";
const PROVIDER = "deepseek";
const MODEL = "deepseek-flash";
const RUNS = Number(process.env.RUNS ?? 5);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MIN ?? 10) * 60_000;
const NEAR_EMPTY = 200; // characters: a Subagent result shorter than this did not do a review
// a Subagent whose tree wrote more than SHRUNK_TOKENS output tokens yet never delivered SHRUNK_CHARS characters lost its work on the way
const SHRUNK_TOKENS = 4000;
const SHRUNK_CHARS = 3000;

const db = new SQL("postgres://orqestra:orqestra@127.0.0.1:55432/orqestra");

// ---------- setup ----------

async function call(method: string, path: string, body?: unknown, quiet = false) {
	const res = await fetch(API + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	// quiet: a validation error could echo the body, which holds the API key
	if (!res.ok)
		throw new Error(`${method} ${path}: ${res.status}${quiet ? "" : ` ${await res.text()}`}`);
	const text = await res.text();
	return text ? JSON.parse(text) : undefined;
}

/** The dev database's key for PROVIDER, decrypted in memory with .env.local's key; never printed or written. */
function devProviderKey() {
	const env = Object.fromEntries(
		readFileSync(`${ROOT}.env.local`, "utf8")
			.split("\n")
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => {
				const i = l.indexOf("=");
				return [l.slice(0, i), l.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
			}),
	);
	const url = env.DATABASE_URL.replace("@localhost", "@127.0.0.1");
	const out = Bun.spawnSync([
		"docker", "exec", "orqestra-pg", "psql", url, "-tAc",
		`select api_key from provider where id = '${PROVIDER}'`,
	]);
	const stored = out.stdout.toString().trim();
	const key = stored ? decryptSecret(stored, encryptionKey(env.ORQESTRA_ENCRYPTION_KEY)) : undefined;
	if (!key) throw new Error(`BLOCKED: no readable ${PROVIDER} key in the dev database (psql exit ${out.exitCode})`);
	return key;
}

/** Configures the Provider, Model and Agent Definitions through the api; safe to rerun. */
async function setup() {
	const { catalog } = await call("GET", "/providers");
	const baseUrl = catalog.find((p: { id: string }) => p.id === PROVIDER)?.baseUrl;
	await call("POST", "/providers", { id: PROVIDER, apiKey: devProviderKey(), baseUrl }, true);
	await call("PUT", "/providers/models", { providerId: PROVIDER, modelId: MODEL, enabled: true });
	await call("PUT", "/providers/models/default", { providerId: PROVIDER, modelId: MODEL });
	const existing = new Set((await call("GET", "/agents")).agents.map((a: { id: string }) => a.id));
	for (const a of AGENTS)
		await call("POST", "/agents", { id: a.id, create: !existing.has(a.id), definition: a.definition });
	const { models, defaultModel } = await call("GET", "/model-options");
	const model = models.find((m: { ref: string }) => m.ref === defaultModel);
	if (model?.ref !== `${PROVIDER}/${MODEL}`) throw new Error(`default Model is ${defaultModel}`);
	// the level the composer starts on: resolveThinking's default
	return { model: model.ref as string, thinking: model.thinking.default as string };
}

// ---------- one run ----------

// question: the lead asked the User a Question (ask_user), which holds its Notifications until they answer
type Settled = { end: "idle" | "failed" | "question" | "stuck"; waitedMs: number };

/** Polls until no Conversation of the tree runs, no waking input waits and no Subagent is queued or running. */
async function settle(rootId: string): Promise<Settled> {
	const started = Date.now();
	let calm = 0;
	while (Date.now() - started < TIMEOUT_MS) {
		await Bun.sleep(4000);
		const [s] = await db`
			select
				(select status from conversation where id = ${rootId}) as root,
				(select awaiting_reply from conversation where id = ${rootId}) as asked,
				(select count(*)::int from conversation where root_id = ${rootId} and status = 'running') as running,
				(select count(*)::int from inbox i join conversation c on c.id = i.conversation_id
					where c.root_id = ${rootId} and i.wake) as waiting,
				(select count(*)::int from subagent s join conversation c on c.id = s.conversation_id
					where c.root_id = ${rootId} and s.outcome in ('queued', 'running')) as active,
				(select count(*)::int from message where conversation_id = ${rootId}
					and message->>'role' = 'assistant') as replies`;
		const still = s.running || (s.waiting && !s.asked) || s.active || (!s.replies && s.root !== "failed");
		calm = still ? 0 : calm + 1;
		// twice in a row: a Notification is written to the inbox in the same transaction that ends its Subagent
		if (calm >= 2)
			return { end: s.asked ? "question" : s.root === "failed" ? "failed" : "idle", waitedMs: Date.now() - started };
	}
	return { end: "stuck", waitedMs: Date.now() - started };
}

type Msg = {
	role: string;
	content: string | { type: string; id?: string; text?: string; name?: string; arguments?: Record<string, unknown> }[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	usage?: { output?: number; cost?: { total?: number } };
};

/** What a Conversation's own steps cost, from each assistant message's usage (titles are only in the usage table). */
const costOf = (ms: { message: Msg }[]) => ms.reduce((n, m) => n + (m.message.usage?.cost?.total ?? 0), 0);

const textOf = (m: Msg) =>
	typeof m.content === "string"
		? m.content
		: m.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

/** Which refusal a failed subagent Tool call met: its arguments did not parse or fit, or the runtime refused it. */
const refusalKind = (error: string) =>
	/^(Validation failed|Invalid arguments)/.test(error)
		? "bad_arguments"
		: /subagents and background calls may be started/.test(error)
			? "budget"
			: /^There is no template/.test(error)
				? "no_such_template"
				: /^There is no subagent/.test(error)
					? "no_such_subagent"
					: "other";

const roleOf = (template: string | null): Role | "general" | "worker" =>
	template === null ? "worker" : (AGENTS.find((a) => a.id === template)?.role ?? "general");

/** Everything the report needs about one tree, from the database. */
async function collect(rootId: string, task: (typeof TASKS)[number], settled: Settled) {
	const convs = await db`select id, parent_id, depth, agent_id, status, failure, awaiting_reply from conversation where root_id = ${rootId}`;
	const root = convs.find((c: { id: string }) => c.id === rootId);
	const subs = await db`
		select s.conversation_id as id, s.number, s.brief, s.outcome, s.result, s.created_at, c.parent_id, c.depth, c.agent_id
		from subagent s join conversation c on c.id = s.conversation_id
		where c.root_id = ${rootId} order by s.created_at, s.number`;
	const msgs: { conversation_id: string; message: Msg; subagent_id: string | null; created_at: Date }[] = await db`
		select m.conversation_id, m.message, m.subagent_id, m.created_at
		from message m join conversation c on c.id = m.conversation_id
		where c.root_id = ${rootId} order by m.id`;
	// titles are generated after the first reply; give their Usage a moment to land
	await Bun.sleep(3000);
	const [use] = await db`
		select count(*)::int as requests, coalesce(sum(input_tokens), 0)::int as input,
			coalesce(sum(output_tokens), 0)::int as output, coalesce(sum(cache_read_tokens), 0)::int as cache_read,
			coalesce(sum(cache_write_tokens), 0)::int as cache_write, coalesce(sum(cost), 0)::float8 as cost
		from usage where conversation_id = ${rootId}`;
	const byAgent = await db`
		select coalesce(agent_id, 'worker') as agent, count(*)::int as requests, sum(cost)::float8 as cost
		from usage where conversation_id = ${rootId} group by 1 order by 3 desc`;

	const t0 = msgs[0]?.created_at.getTime() ?? Date.now();
	const at = (d: Date) => Math.round((d.getTime() - t0) / 1000);
	const numberOf = new Map(subs.map((s: { id: string; number: number }) => [s.id, s.number]));

	const subagents = subs.map((s: Record<string, any>) => {
		const own = msgs.filter((m) => m.conversation_id === s.id);
		// what its parent was handed, each time: a Subagent woken again (by its own Subagents, or continued) notifies again
		const notes = msgs.filter((m) => m.subagent_id === s.id).map((m) => ({ at: at(m.created_at), text: textOf(m.message) }));
		const notified = notes.map((n) => n.at);
		const delivered = Math.max(0, ...notes.map((n) => n.text.length));
		const outputTokens = own.reduce((n, m) => n + (m.message.usage?.output ?? 0), 0);
		return {
			id: s.id as string,
			parentId: s.parent_id as string,
			number: s.number,
			depth: s.depth,
			parent: s.parent_id === rootId ? "lead" : `#${numberOf.get(s.parent_id)}`,
			template: s.agent_id as string | null,
			role: roleOf(s.agent_id),
			fits: s.parent_id === rootId && (task.fits as readonly string[]).includes(s.agent_id),
			outcome: s.outcome as string,
			brief: s.brief as string,
			// the brief asks for files under /workspace, which the subagent Tool describes even when there is no Sandbox
			asksForFiles: (s.brief as string).includes("/workspace"),
			result: (s.result ?? "") as string,
			resultChars: (s.result ?? "").length,
			nearEmpty: (s.result ?? "").trim().length < NEAR_EMPTY,
			notes,
			// inputs after its brief: Notifications from its own Subagents, or its parent's further messages
			woken: own.filter((m) => m.message.role === "user").length - 1,
			outputTokens,
			delivered,
			startedAt: at(s.created_at),
			finishedAt: own.length ? at(own[own.length - 1].created_at) : null,
			// when its first Run ended with a reply: later than this, it was waiting on its own Subagents or rerunning
			firstStopAt: ((m) => (m ? at(m.created_at) : null))(own.find((m) => m.message.role === "assistant" && m.message.stopReason === "stop")),
			notifiedAt: notified,
			steps: own.filter((m) => m.message.role === "assistant").length,
			cost: costOf(own),
		};
	});

	// it and its own Subagents wrote a lot, but every Notification it sent was short: the work stayed behind, in an earlier Run or a child
	const below = (id: string): number =>
		subagents.filter((x) => x.parentId === id).reduce((n, x) => n + x.outputTokens + below(x.id), 0);
	const tree = subagents.map((x) => {
		const treeOutputTokens = x.outputTokens + below(x.id);
		return { ...x, treeOutputTokens, shrunk: x.notes.length > 0 && treeOutputTokens > SHRUNK_TOKENS && x.delivered < SHRUNK_CHARS };
	});

	// every subagent Tool call in the tree, with the template it asked for and whether it was refused
	const calls: { id: string; by: string; tool: string; templates: (string | null)[]; error?: string }[] = [];
	for (const m of msgs) {
		if (m.message.role === "toolResult" && m.message.isError) {
			const call = calls.find((c) => c.id === m.message.toolCallId);
			if (call) call.error = textOf(m.message);
		}
		if (m.message.role !== "assistant" || typeof m.message.content === "string") continue;
		for (const c of m.message.content)
			if (c.type === "toolCall" && c.name?.startsWith("subagent"))
				calls.push({
					id: c.id!,
					by: m.conversation_id === rootId ? "lead" : `#${numberOf.get(m.conversation_id)}`,
					tool: c.name,
					// one task per call since b8f8058, a `tasks` array before
					templates: ((c.arguments?.tasks as { template?: string }[] | undefined) ?? (c.name === "subagent" ? [c.arguments as { template?: string }] : [])).map((t) => t.template ?? null),
				});
	}

	// steps whose every Tool call was a refused subagent call: what they cost bought nothing
	const refusedIds = new Set(calls.filter((c) => c.error).map((c) => c.id));
	const wasted = msgs.filter((m) => {
		if (m.message.role !== "assistant" || typeof m.message.content === "string") return false;
		const ids = m.message.content.filter((c) => c.type === "toolCall").map((c) => c.id!);
		return ids.length > 0 && ids.every((id) => refusedIds.has(id));
	});
	const rootNotes = msgs.filter((m) => m.conversation_id === rootId && m.subagent_id);
	// the Question an ask_user call put to the User, which the User sees after the message's text
	const askedIn = (m: Msg) => {
		if (typeof m.content === "string") return "";
		const ask = m.content.find((c) => c.type === "toolCall" && c.name === "ask_user");
		return ask ? `\n\n[向用户提问，等待回答] ${ask.arguments?.question}\n建议答案：${(ask.arguments?.suggestions as string[] | undefined)?.join(" / ") ?? "无"}` : "";
	};
	const leadReplies = msgs
		.filter((m) => m.conversation_id === rootId && m.message.role === "assistant" && (textOf(m.message) + askedIn(m.message)).trim())
		.map((m) => ({
			at: at(m.created_at),
			text: textOf(m.message) + askedIn(m.message),
			stopReason: m.message.stopReason,
			// Subagents (by number) whose Notification the lead had been handed when it wrote this
			notifiedBefore: rootNotes.filter((n) => n.created_at < m.created_at).map((n) => numberOf.get(n.subagent_id!)),
		}));
	const final = leadReplies.at(-1);
	const direct = subagents.filter((s) => s.parent === "lead");
	const errors = msgs
		.filter((m) => m.message.role === "assistant" && m.message.stopReason === "error")
		.map((m) => m.message.errorMessage ?? "error");

	const record = {
		task: task.id,
		conversationId: rootId,
		// a run the harness timed out only because the lead's Question held its Notifications ended on that Question
		end: settled.end === "stuck" && root.awaiting_reply && !tree.some((x) => x.outcome === "stopped") ? ("question" as const) : settled.end,
		rootFailure: root.failure ?? null,
		finalReplyChars: final?.text.length ?? 0,
		// the lead had every direct Subagent's Notification before its last reply
		finalAfterAllNotes: !!final && direct.every((s) => s.notifiedAt.some((n) => n <= final.at)),
		leadRuns: msgs.filter((m) => m.conversation_id === rootId && m.message.role === "user").length,
		subagents: tree,
		calls,
		refusals: calls.filter((c) => c.error).map((c) => ({ by: c.by, tool: c.tool, kind: refusalKind(c.error!), error: c.error!.slice(0, 200) })),
		modelErrors: errors,
		leadReplies,
		usage: { ...use, byAgent, lead: costOf(msgs.filter((m) => m.conversation_id === rootId)), refusedSteps: costOf(wasted) },
		wallS: msgs.length ? at(msgs[msgs.length - 1].created_at) : null,
		waitedS: Math.round(settled.waitedMs / 1000),
	};
	// did the work happen: an idle tree with a reply spent tokens
	if (record.end === "idle" && (!final || !use.requests)) throw new Error(`${rootId}: idle with no reply or no Usage`);
	return record;
}

type RunRecord = Awaited<ReturnType<typeof collect>> & { label: string };

// ---------- judge packets ----------

const ROLE_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.definition.name as string]));

/**
 * What the blinded judges see: shuffled labels, the request, the lead's messages and its own Subagents' results in time order.
 * One packet per run number, so each judge sees one run of every task; a nested Subagent's result went to its parent, not the lead, so only its role is shown.
 */
function judgePackets(runs: RunRecord[]) {
	// a fixed shuffle of the whole schedule, so a run keeps its label while the others are still going
	const schedule = Array.from({ length: RUNS }, (_, i) => TASKS.map((t) => `${t.id}-${i + 1}`))
		.flat()
		.sort((a, b) => Number(Bun.hash(a)) - Number(Bun.hash(b)));
	const order = [...runs].sort((a, b) => schedule.indexOf(a.label) - schedule.indexOf(b.label));
	const labels: Record<string, string> = {};
	const sections = new Map<string, string[]>();
	order.forEach((r) => {
		const label = `R${String(schedule.indexOf(r.label) + 1).padStart(2, "0")}`;
		labels[label] = r.conversationId;
		const role = (t: string | null) => (t ? (ROLE_NAME[t] ?? t) : "通用");
		const events = [
			...r.leadReplies.map((m, j) => ({
				at: m.at,
				text: `### [t+${m.at}s] 负责人消息 ${j + 1}${j === r.leadReplies.length - 1 ? (r.end === "question" ? "（最终答复：以向用户提问结束，之后送达的结果要等用户回答才交给负责人）" : "（最终答复）") : ""}\n写这条消息时已送达的子任务结果：${m.notifiedBefore.length ? m.notifiedBefore.join("、") : "无"}\n\n${m.text}`,
			})),
			...r.subagents
				.filter((s) => s.parent === "lead")
				.flatMap((s) => {
					const nested = r.subagents.filter((x) => x.parent === `#${s.number}`);
					const head = `（角色：${role(s.template)}）\n任务说明（节选）：${s.brief.slice(0, 300).replaceAll("\n", " ")}……${nested.length ? `\n它自己又派了 ${nested.length} 个子任务（${nested.map((x) => role(x.template)).join("、")}），那些结果交给它，负责人看不到。` : ""}`;
					if (!s.notes.length)
						return [{ at: s.finishedAt ?? 0, text: `### 子任务 ${s.number} 的结果从未送达负责人${head}\n\n结局：${s.outcome}` }];
					return s.notes.map((n, k) => ({
						at: n.at,
						text: `### [t+${n.at}s] 子任务 ${s.number} 的结果送达负责人${s.notes.length > 1 ? `（第 ${k + 1} 次，共 ${s.notes.length} 次）` : ""}${k === 0 ? head : ""}\n\n送达的内容：\n${n.text}`,
					}));
				}),
		].sort((a, b) => a.at - b.at);
		const task = TASKS.find((t) => t.id === r.task)!;
		const key = r.label.split("-").at(-1)!;
		sections.set(key, [...(sections.get(key) ?? []), `## ${label}\n\n用户请求：\n\n${task.prompt}\n\n${events.map((e) => e.text).join("\n\n")}`]);
	});
	return { labels, packets: [...sections].map(([n, parts]) => [n, parts.join("\n\n---\n\n")] as const) };
}

/** Writes labels.json and judge-packet-<n>.md into dir. */
function writePackets(dir: string, runs: RunRecord[]) {
	const { labels, packets } = judgePackets(runs);
	writeFileSync(`${dir}/labels.json`, JSON.stringify(labels, null, 2));
	for (const [n, p] of packets) writeFileSync(`${dir}/judge-packet-${n}.md`, p);
}

// ---------- report ----------

const pct = (n: number, d: number) => (d ? `${n}/${d}` : "0/0");
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : "-");

type Verdict = {
	label: string;
	premature: boolean;
	dropped: { subagent: number; finding: string }[];
	fabricated: string[];
	coverage: 0 | 1 | 2;
	notes?: string;
};

function report(dir: string) {
	const runs: RunRecord[] = JSON.parse(readFileSync(`${dir}/runs.json`, "utf8"));
	const labels: Record<string, string> = existsSync(`${dir}/labels.json`)
		? JSON.parse(readFileSync(`${dir}/labels.json`, "utf8"))
		: {};
	const verdicts: Verdict[] = existsSync(`${dir}/judge.json`) ? JSON.parse(readFileSync(`${dir}/judge.json`, "utf8")) : [];
	const verdictOf = (r: RunRecord) => verdicts.find((v) => labels[v.label] === r.conversationId);
	const labelOf = (r: RunRecord) => Object.keys(labels).find((l) => labels[l] === r.conversationId) ?? "";

	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const subsOf = (rs: RunRecord[]) => rs.flatMap((r) => r.subagents);
	const judged = (rs: RunRecord[], f: (vs: Verdict[]) => string) => {
		const vs = rs.map(verdictOf).filter((v): v is Verdict => !!v);
		return vs.length ? f(vs) : "-";
	};
	const refused = (rs: RunRecord[], kind: string) => sum(rs.map((r) => r.refusals.filter((x) => x.kind === kind).length));
	// one column: its header and its cell for a group of runs
	type Column = [string, (rs: RunRecord[]) => string | number];
	const tables: [string, Column[]][] = [
		[
			"路由",
			[
				["idle/failed/question/stuck", (rs) => ["idle", "failed", "question", "stuck"].map((e) => rs.filter((r) => r.end === e).length).join("/")],
				["有委派的运行", (rs) => `${rs.filter((r) => r.subagents.length).length}/${rs.length}`],
				["子任务数 中位(范围)", (rs) => `${median(rs.map((r) => r.subagents.length))} (${range(rs.map((r) => r.subagents.length))})`],
				["负责人直派命中团队", (rs) => pct(subsOf(rs).filter((x) => x.parent === "lead" && x.fits).length, subsOf(rs).filter((x) => x.parent === "lead").length)],
				["派给干扰模板", (rs) => subsOf(rs).filter((x) => x.role === "distractor").length],
				["派给 general / 无模板", (rs) => subsOf(rs).filter((x) => x.role === "general" || x.role === "worker").length],
				["派给负责人自身", (rs) => subsOf(rs).filter((x) => x.role === "lead").length],
				["二级子任务", (rs) => subsOf(rs).filter((x) => x.depth > 1).length],
				["有二级的运行", (rs) => rs.filter((r) => r.subagents.some((x) => x.depth > 1)).length],
				["说明里要 /workspace 文件", (rs) => {
					const [d, n] = [subsOf(rs).filter((x) => x.depth === 1), subsOf(rs).filter((x) => x.depth > 1)];
					return `直派 ${d.filter((x) => x.asksForFiles).length}/${d.length}，二级 ${n.filter((x) => x.asksForFiles).length}/${n.length}`;
				}],
				["被拒：参数错", (rs) => refused(rs, "bad_arguments")],
				["被拒：无此模板", (rs) => refused(rs, "no_such_template")],
				["被拒：预算", (rs) => refused(rs, "budget")],
				["被拒：其他", (rs) => refused(rs, "other") + refused(rs, "no_such_subagent")],
			],
		],
		[
			"结果",
			[
				["结局 完成/partial/失败/停止/未结束", (rs) => ["completed", "partial", "failed", "stopped"].map((o) => subsOf(rs).filter((x) => x.outcome === o).length).concat(subsOf(rs).filter((x) => x.outcome === "queued" || x.outcome === "running").length).join("/")],
				[`近空结果（<${NEAR_EMPTY} 字）`, (rs) => subsOf(rs).filter((x) => x.nearEmpty).length],
				["被再次唤醒的直派子任务", (rs) => subsOf(rs).filter((x) => x.parent === "lead" && x.woken > 0).length],
				[`交付缩水（连同下级写了>${SHRUNK_TOKENS} tokens，送达<${SHRUNK_CHARS} 字）`, (rs) => subsOf(rs).filter((x) => x.parent === "lead" && x.shrunk).length],
				["最后一条负责人消息前没拿齐直派结果", (rs) => rs.filter((r) => !r.finalAfterAllNotes).length],
				["判定：提前声称", (rs) => judged(rs, (vs) => `${vs.filter((v) => v.premature).length}/${vs.length}`)],
				["判定：有遗漏的运行", (rs) => judged(rs, (vs) => `${vs.filter((v) => v.dropped.length).length}/${vs.length}`)],
				["判定：遗漏条数", (rs) => judged(rs, (vs) => String(sum(vs.map((v) => v.dropped.length))))],
				["判定：有捏造的运行", (rs) => judged(rs, (vs) => `${vs.filter((v) => v.fabricated.length).length}/${vs.length}`)],
				["判定：覆盖=2", (rs) => judged(rs, (vs) => `${vs.filter((v) => v.coverage === 2).length}/${vs.length}`)],
			],
		],
		[
			"成本与时间",
			[
				["请求数 中位", (rs) => median(rs.map((r) => r.usage.requests))],
				["tokens 中位（入+出+缓存读）", (rs) => median(rs.map((r) => r.usage.input + r.usage.output + r.usage.cache_read))],
				["成本 USD 中位(范围)", (rs) => `${median(rs.map((r) => r.usage.cost)).toFixed(4)} (${Math.min(...rs.map((r) => r.usage.cost)).toFixed(4)}–${Math.max(...rs.map((r) => r.usage.cost)).toFixed(4)})`],
				["成本 USD 合计", (rs) => sum(rs.map((r) => r.usage.cost)).toFixed(4)],
				["成本占比 负责人/一级/二级", (rs) => {
					const total = sum(rs.map((r) => r.usage.cost)) || 1;
					const share = (n: number) => `${Math.round((100 * n) / total)}%`;
					return [sum(rs.map((r) => r.usage.lead)), sum(subsOf(rs).filter((x) => x.depth === 1).map((x) => x.cost)), sum(subsOf(rs).filter((x) => x.depth > 1).map((x) => x.cost))].map(share).join("/");
				}],
				["被拒步骤的成本占比", (rs) => `${Math.round((100 * sum(rs.map((r) => r.usage.refusedSteps))) / (sum(rs.map((r) => r.usage.cost)) || 1))}%`],
				["直派首次答完到最后送达 s 中位", (rs) => median(subsOf(rs).filter((x) => x.parent === "lead" && x.firstStopAt !== null && x.notifiedAt.length).map((x) => x.notifiedAt.at(-1)! - x.firstStopAt!))],
				["墙钟 s 中位(范围)", (rs) => `${median(rs.map((r) => r.wallS ?? 0))} (${range(rs.map((r) => r.wallS ?? 0))})`],
			],
		],
	];
	const groups: [string, RunRecord[]][] = [...TASKS.map((t): [string, RunRecord[]] => [t.id, runs.filter((r) => r.task === t.id)]), ["合计", runs]];
	const table = ([title, cols]: [string, Column[]]) =>
		`### ${title}\n\n| 任务 | 次数 | ${cols.map((c) => c[0]).join(" | ")} |\n|${"---|".repeat(cols.length + 2)}\n${groups
			.filter(([, rs]) => rs.length)
			.map(([name, rs]) => `| ${name} | ${rs.length} | ${cols.map((c) => c[1](rs)).join(" | ")} |`)
			.join("\n")}`;
	const perRun = runs.map((r) => {
		const v = verdictOf(r);
		const tree = r.subagents.map((x) => `${x.parent === "lead" ? "" : `${x.parent}>`}#${x.number} ${x.template ?? "worker"}:${x.outcome}${x.nearEmpty ? "(空)" : ""}`).join(", ");
		const verdict = v ? `${v.premature ? "提前声称；" : ""}遗漏 ${v.dropped.length}，捏造 ${v.fabricated.length}，覆盖 ${v.coverage}` : "";
		return `| ${r.label} | ${labelOf(r)} | ${r.conversationId} | ${r.end} | ${tree || "无"} | ${r.refusals.map((x) => `${x.by}:${x.kind}`).join(", ")} | ${verdict} | ${r.usage.cost.toFixed(4)} | ${r.wallS} |`;
	});
	const md = `${tables.map(table).join("\n\n")}\n\n### 每次运行\n\n| 运行 | 评判标签 | Conversation | 结束 | 子任务（父>#编号 模板:结局） | 被拒 | 判定 | 成本 USD | 墙钟 s |\n|---|---|---|---|---|---|---|---|---|\n${perRun.join("\n")}\n`;
	writeFileSync(`${dir}/metrics.md`, md);
	console.log(md);
}

// ---------- main ----------

async function main() {
	if (process.argv[2] === "report") return report(process.argv[3] ?? "");
	if (process.argv[2] === "recollect") {
		// redoes every record of <dir> from the database of the instance still up, then the packet and the report
		const dir = process.argv[3] ?? "";
		const old: RunRecord[] = JSON.parse(readFileSync(`${dir}/runs.json`, "utf8"));
		const runs: RunRecord[] = [];
		for (const r of old) {
			const task = TASKS.find((t) => t.id === r.task)!;
			const settled: Settled = { end: r.end, waitedMs: r.waitedS * 1000 };
			runs.push({ label: r.label, ...(await collect(r.conversationId, task, settled)) });
		}
		writeFileSync(`${dir}/runs.json`, JSON.stringify(runs, null, 2));
		writePackets(dir, runs);
		await db.close();
		return report(dir);
	}
	const doctor = Bun.spawnSync(["bash", VERIFY, "doctor"]);
	const ours = doctor.exitCode !== 0;
	if (ours) {
		const up = Bun.spawnSync(["bash", VERIFY, "up"], { stdout: "inherit", stderr: "inherit" });
		if (up.exitCode !== 0) throw new Error("BLOCKED: verify.sh up failed (see above)");
	}
	try {
		const pick = await setup();
		const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
		const dir = `${HERE}results/${stamp}`;
		mkdirSync(dir, { recursive: true });
		const runs: RunRecord[] = [];
		// interleaved by task, so drift in the Provider's latency falls on every task alike
		for (let i = 1; i <= RUNS; i++)
			for (const task of TASKS.filter((t) => !process.env.ONLY || t.id === process.env.ONLY)) {
				const label = `${task.id}-${i}`;
				const { conversationId } = await call("POST", "/messages", {
					agentId: LEAD,
					text: task.prompt,
					model: pick.model,
					thinking: pick.thinking,
					// no Memory or Recall, so one run cannot read another
					incognito: true,
				});
				const settled = await settle(conversationId);
				if (settled.end === "stuck") await call("POST", `/conversations/${conversationId}/stop`);
				const record = await collect(conversationId, task, settled).then(
					(r) => ({ label, ...r }),
					// kept so `recollect` can redo it once the collector is fixed
					(e) => ({ label, task: task.id, conversationId, end: settled.end, waitedS: Math.round(settled.waitedMs / 1000), collectError: String(e) }) as never,
				);
				runs.push(record);
				writeFileSync(`${dir}/runs.json`, JSON.stringify(runs, null, 2));
				console.log(
					`${label} ${conversationId} ${record.end} subagents=${record.subagents.map((s) => `${s.template ?? "worker"}:${s.outcome}`).join(",")} refusals=${record.refusals.length} cost=${record.usage.cost.toFixed(4)} wall=${record.wallS}s`,
				);
			}
		writePackets(dir, runs);
		report(dir);
		console.log(`results in ${dir}`);
	} finally {
		await db.close();
		if (ours) Bun.spawnSync(["bash", VERIFY, "down"], { stdout: "inherit" });
	}
}

await main();
