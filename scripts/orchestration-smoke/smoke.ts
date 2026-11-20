#!/usr/bin/env bun
// A smoke test of Subagent orchestration with a real Model: a lead Agent and its team on a throwaway verify instance.
// It checks only what the database shows plainly (how each tree ended, Subagents' Outcomes, refused calls, Model errors,
// empty handovers), not how good the answers are. Exits 1 when a check fails.
//
//   bun scripts/orchestration-smoke/smoke.ts     # setup + runs, into results/<stamp>/ (runs.json, summary.md)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SQL } from "bun";
import { decryptSecret, encryptionKey } from "../../packages/db/src/secret.ts";
import { AGENTS, LEAD, TASKS } from "./fixtures.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;
const VERIFY = `${ROOT}.claude/skills/verify-orqestra/scripts/verify.sh`;
const API = "http://127.0.0.1:3001/api";
const PROVIDER = "deepseek";
const MODEL = "deepseek-flash";
const RUNS = Number(process.env.RUNS ?? 1);
// top-level Conversations at once; each takes the next job when it is done
const PARALLEL = Number(process.env.PARALLEL ?? TASKS.length);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MIN ?? 20) * 60_000;
// SANDBOX=1: the dev database's Sandbox Provider (orrery) too, so Agents get a Sandbox and share files through it
const SANDBOX = process.env.SANDBOX === "1";
const SHORT = 200; // characters: a handover shorter than this is worth a look

const db = new SQL("postgres://orqestra:orqestra@127.0.0.1:55432/orqestra");

// ---------- setup ----------

async function call(method: string, path: string, body?: unknown, quiet = false) {
	const res = await fetch(API + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	// quiet: a validation error could echo the body, which holds a secret
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status}${quiet ? "" : ` ${await res.text()}`}`);
	const text = await res.text();
	return text ? JSON.parse(text) : undefined;
}

/** One secret column from the dev database, decrypted in memory with .env.local's key; never printed or written. */
function devSecret(query: string, what: string) {
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
	const out = Bun.spawnSync(["docker", "exec", "orqestra-pg", "psql", url, "-tAc", query]);
	const stored = out.stdout.toString().trim();
	const secret = stored ? decryptSecret(stored, encryptionKey(env.ORQESTRA_ENCRYPTION_KEY)) : undefined;
	if (!secret) throw new Error(`BLOCKED: no readable ${what} in the dev database (psql exit ${out.exitCode})`);
	return { secret, url };
}

// KEY_FILE: a file holding the key, for one newer than the dev database's; never printed or written either
const providerKey = () =>
	process.env.KEY_FILE
		? readFileSync(process.env.KEY_FILE, "utf8").trim()
		: devSecret(`select api_key from provider where id = '${PROVIDER}'`, `${PROVIDER} key`).secret;

/** The dev database's Sandbox Provider, its token decrypted in memory. */
function devSandboxProvider() {
	const { secret, url } = devSecret("select token from sandbox_provider", "Sandbox Provider token");
	const out = Bun.spawnSync([
		"docker", "exec", "orqestra-pg", "psql", url, "-tAc",
		"select json_build_object('url', url, 'snapshot', coalesce(snapshot, ''), 'cpu', cpu, 'memory', memory) from sandbox_provider",
	]);
	return { ...JSON.parse(out.stdout.toString().trim()), token: secret };
}

/** Configures the Provider, Model, Sandbox Provider and Agent Definitions through the api; safe to rerun. */
async function setup() {
	const { catalog } = await call("GET", "/providers");
	const baseUrl = catalog.find((p: { id: string }) => p.id === PROVIDER)?.baseUrl;
	await call("POST", "/providers", { id: PROVIDER, apiKey: providerKey(), baseUrl }, true);
	await call("PUT", "/providers/models", { providerId: PROVIDER, modelId: MODEL, enabled: true });
	await call("PUT", "/providers/models/default", { providerId: PROVIDER, modelId: MODEL });
	if (SANDBOX) {
		const saved = await call("POST", "/sandbox-provider", devSandboxProvider(), true);
		if (Object.keys(saved?.errors ?? {}).length)
			throw new Error(`BLOCKED: the Sandbox Provider was refused: ${Object.keys(saved.errors).join(", ")}`);
	}
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

// question: the lead asked the User a Question, which holds its Notifications until they answer
type End = "idle" | "failed" | "question" | "stuck";

/** Polls until no Conversation of the tree runs, no waking input waits and no Subagent is queued or running. */
async function settle(rootId: string): Promise<End> {
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
		if (calm >= 2) return s.asked ? "question" : s.root === "failed" ? "failed" : "idle";
	}
	return "stuck";
}

type Msg = {
	role: string;
	content: string | { type: string; text?: string; name?: string }[];
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
};

const textOf = (m: Msg) =>
	typeof m.content === "string"
		? m.content
		: m.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

/** What the database shows of one tree, and the checks it passes or fails. */
async function collect(rootId: string, task: (typeof TASKS)[number], end: End) {
	const [root] = await db`select failure from conversation where id = ${rootId}`;
	const subagents = await db`
		select s.number, s.outcome, coalesce(s.result, '') as result, c.depth, c.agent_id as template, c.title
		from subagent s join conversation c on c.id = s.conversation_id
		where c.root_id = ${rootId} order by c.depth, s.created_at`;
	const msgs: { conversation_id: string; message: Msg; created_at: Date }[] = await db`
		select m.conversation_id, m.message, m.created_at
		from message m join conversation c on c.id = m.conversation_id
		where c.root_id = ${rootId} order by m.id`;
	const [use] = await db`select coalesce(sum(cost), 0)::float8 as cost from usage where conversation_id = ${rootId}`;
	const replied = msgs.some((m) => m.conversation_id === rootId && m.message.role === "assistant" && textOf(m.message).trim());
	const refused = msgs.filter(
		(m) => m.message.role === "toolResult" && m.message.isError && m.message.toolName?.startsWith("subagent"),
	);
	const modelErrors = msgs.filter((m) => m.message.stopReason === "error").map((m) => m.message.errorMessage ?? "error");
	const bashTimeouts = msgs.filter(
		(m) => m.message.role === "toolResult" && m.message.toolName === "bash" && textOf(m.message).includes("its time limit"),
	).length;

	const fail: string[] = [];
	const warn: string[] = [];
	if (end === "failed") fail.push(`the lead's Conversation failed: ${root?.failure ?? "?"}`);
	if (end === "stuck") fail.push(`not settled after ${TIMEOUT_MS / 60_000} minutes`);
	if (end === "idle" && !replied) fail.push("idle without a reply");
	for (const s of subagents) {
		const who = `#${s.number}${s.depth > 1 ? ` (depth ${s.depth})` : ""} ${s.template ?? "worker"}`;
		if (s.outcome === "failed" || s.outcome === "partial") fail.push(`${who} ${s.outcome}: ${s.result.slice(0, 120)}`);
		else if (s.outcome === "stopped") warn.push(`${who} stopped`);
		else if (!s.result.trim()) fail.push(`${who} handed back nothing`);
		else if (s.result.trim().length < SHORT) warn.push(`${who} handed back ${s.result.trim().length} characters`);
	}
	for (const r of refused) fail.push(`refused ${r.message.toolName}: ${textOf(r.message).slice(0, 120)}`);
	for (const e of modelErrors) fail.push(`Model error: ${e.slice(0, 120)}`);
	if (task.delegates && !subagents.length) warn.push("started no Subagent");
	if (subagents.some((s: { depth: number }) => s.depth > 1)) warn.push("nested Subagents");
	if (bashTimeouts) warn.push(`${bashTimeouts} bash command(s) hit their time limit`);

	const first = msgs[0]?.created_at.getTime() ?? Date.now();
	return {
		task: task.id,
		conversationId: rootId,
		end,
		subagents: subagents.map((s: Record<string, unknown>) => ({ ...s, result: String(s.result).slice(0, 2000) })),
		bashTimeouts,
		cost: use.cost as number,
		wallS: msgs.length ? Math.round((msgs[msgs.length - 1].created_at.getTime() - first) / 1000) : 0,
		fail,
		warn,
	};
}

type RunRecord = Awaited<ReturnType<typeof collect>> & { label: string };

/** One line per run, then its failures and warnings. */
function summary(runs: RunRecord[]) {
	const lines = runs.map(
		(r) =>
			`| ${r.label} | ${r.fail.length ? "FAIL" : "ok"} | ${r.end} | ${r.subagents.map((s) => `${s.template ?? "worker"}:${s.outcome}`).join(", ") || "-"} | ${r.cost.toFixed(4)} | ${r.wallS} |`,
	);
	const notes = runs.flatMap((r) => [...r.fail.map((f) => `- ${r.label} FAIL ${f}`), ...r.warn.map((w) => `- ${r.label} warn ${w}`)]);
	return [
		"| 运行 | 结论 | 结束 | 子任务 | 成本 USD | 墙钟 s |",
		"|---|---|---|---|---|---|",
		...lines,
		"",
		...(notes.length ? notes : ["- 没有失败或提示"]),
	].join("\n");
}

// ---------- main ----------

const doctor = Bun.spawnSync(["bash", VERIFY, "doctor"]);
const ours = doctor.exitCode !== 0;
if (ours) {
	const up = Bun.spawnSync(["bash", VERIFY, "up"], { stdout: "inherit", stderr: "inherit" });
	if (up.exitCode !== 0) throw new Error("BLOCKED: verify.sh up failed (see above)");
}
// the top-level Conversations this test started: deleting one deletes its tree's Sandbox, a real machine at orrery
const started: string[] = [];
let failed = false;
try {
	const pick = await setup();
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	const dir = `${HERE}results/${stamp}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/setup.json`, JSON.stringify({ ...pick, sandbox: SANDBOX, runs: RUNS, parallel: PARALLEL }));
	const jobs = Array.from({ length: RUNS }, (_, i) => TASKS.map((task) => ({ task, label: `${task.id}-${i + 1}` }))).flat();
	const runs: RunRecord[] = [];
	const one = async ({ task, label }: (typeof jobs)[number]) => {
		const { conversationId } = await call("POST", "/messages", {
			agentId: LEAD,
			text: task.prompt,
			model: pick.model,
			thinking: pick.thinking,
			// no Memory or Recall, so one run cannot read another
			incognito: true,
		});
		started.push(conversationId);
		const end = await settle(conversationId);
		if (end === "stuck") await call("POST", `/conversations/${conversationId}/stop`);
		runs.push({ label, ...(await collect(conversationId, task, end)) });
		runs.sort((a, b) => jobs.findIndex((j) => j.label === a.label) - jobs.findIndex((j) => j.label === b.label));
		writeFileSync(`${dir}/runs.json`, JSON.stringify(runs, null, 2));
		console.log(`${label} ${conversationId} ${runs.find((r) => r.label === label)?.fail.length ? "FAIL" : "ok"}`);
	};
	let next = 0;
	await Promise.all(
		Array.from({ length: PARALLEL }, async () => {
			while (next < jobs.length) await one(jobs[next++]);
		}),
	);
	const text = summary(runs);
	writeFileSync(`${dir}/summary.md`, `${text}\n`);
	console.log(`\n${text}\n\nresults in ${dir}`);
	failed = runs.some((r) => r.fail.length);
} finally {
	// a Sandbox smoke test's Conversations go, their Sandboxes with them; runs.json keeps what was checked
	if (SANDBOX)
		for (const id of started)
			await call("DELETE", `/conversations/${id}`).catch(async (e) => {
				const [c] = await db`select sandbox_id from conversation where id = ${id}`;
				console.error(`left ${id}, its Sandbox ${c?.sandbox_id ?? "none"} at orrery: ${e}`);
			});
	await db.close();
	if (ours) Bun.spawnSync(["bash", VERIFY, "down"], { stdout: "inherit" });
}
process.exit(failed ? 1 : 0);
