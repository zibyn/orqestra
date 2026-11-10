import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	DEFAULT_LIMITS,
	type OrqestraConfig,
} from "@orqestra/config";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { RunHandle, TaskInput } from "./index.ts";

// the push service, as web-push reaches it: each push recorded, answered with the status `refuse` gives its endpoint
const push = vi.hoisted(() => ({
	sent: [] as {
		endpoint: string;
		payload: { title: string; status: string; url: string };
	}[],
	refuse: new Map<string, number>(),
}));
vi.mock("web-push", () => ({
	default: {
		sendNotification: async (
			sub: { endpoint: string },
			payload: string,
			options: { vapidDetails: { publicKey: string } },
		) => {
			if (options.vapidDetails.publicKey !== "public") throw new Error("keys");
			const status = push.refuse.get(sub.endpoint);
			if (status)
				throw Object.assign(new Error("refused"), { statusCode: status });
			push.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
		},
	},
}));

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { createConversations } = await import("./index.ts");

const vapid = {
	VAPID_PUBLIC_KEY: "public",
	VAPID_PRIVATE_KEY: "private",
	VAPID_SUBJECT: "mailto:admin@example.com",
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const agent = (over: Partial<AgentDefinition> = {}) =>
	({
		id: "faux",
		name: "faux",
		description: "test Agent",
		instructions: "",
		models: ["faux/faux-1"],
		defaultModel: "faux/faux-1",
		thinking: {},
		default: true,
		memory: false,
		pickable: true,
		allModels: false,
		tools: [],
		skills: [],
		unavailableModels: [],
		...over,
	}) as AgentDefinition;
const base = {
	agents: [agent()],
	models: faux.models,
	defaultAgent: agent(),
	skills: {},
	limits: { ...DEFAULT_LIMITS, minFiringInterval: 1 },
} as unknown as OrqestraConfig;
let config = base;
const conversations = createConversations({
	config: async () => config,
	skillFiles: async () => [],
});
const { tasks } = conversations;
const ada = "ada";

const input = (over: Partial<TaskInput> = {}): TaskInput => ({
	name: "News",
	prompt: "Summarize the news",
	agentId: "faux",
	model: "faux/faux-1",
	thinking: "off",
	schedule: { kind: "once", at: new Date(Date.now() + 300).toISOString() },
	endsAt: null,
	timeZone: "UTC",
	incognito: false,
	alertOnComplete: true,
	enabled: true,
	...over,
});

/** How each Run ends: its reply, then a plain finish, a Question, the step cap, a failure, or waiting to be stopped. */
type End = "complete" | "question" | "partial" | "fail" | "hold";
let end: End = "complete";
async function handle(run: RunHandle) {
	await run.save(fauxAssistantMessage("done"));
	if (end === "fail") throw new Error("boom");
	await run.setTitle("Greetings");
	if (end === "hold")
		await new Promise((r) => run.signal.addEventListener("abort", r));
	if (end === "question") await run.finish(undefined, { question: true });
	else
		await run.finish(
			end === "partial" ? { outcome: "partial", result: "" } : undefined,
		);
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 200; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}
const alerts = async () => push.sent.map((s) => s.payload);
/** Gives a Run's end time to send what it would, then the Alerts sent. */
const settled = async () => {
	await new Promise((r) => setTimeout(r, 400));
	return alerts();
};
const subscribe = (userId: string, endpoint: string, auth = "a") =>
	conversations.alerts.subscribe(userId, {
		endpoint,
		keys: { p256dh: "p", auth },
	});
const firingOf = async (taskId: string) =>
	(
		await waitFor(
			() => tasks.get(ada, taskId),
			(t) => !!t?.firings[0] && t.firings[0].outcome !== "running",
		)
	)?.firings[0] as { outcome: string; conversationId: string | null };

describe.skipIf(!url)("Alerts (Postgres)", { timeout: 20_000 }, () => {
	let stopWorker: () => Promise<void>;
	beforeAll(async () => {
		stopWorker = await conversations.serveRuns(handle);
	});
	afterAll(() => stopWorker?.());
	beforeEach(async () => {
		Object.assign(process.env, vapid);
		config = base;
		end = "complete";
		push.sent.length = 0;
		push.refuse.clear();
		await db.execute(
			sql`truncate conversation, scheduled_task, push_subscription cascade`,
		);
		await subscribe(ada, "https://push.example/ada-phone");
		await subscribe(ada, "https://push.example/ada-laptop");
		await subscribe("bob", "https://push.example/bob");
	});

	it("sends one Alert of just the title, status and url to each of the User's browsers when their Run ends", async () => {
		const id = await conversations.send(ada, { text: "hi" });
		await waitFor(alerts, (a) => a.length === 2);
		expect(await settled()).toHaveLength(2);
		expect(push.sent.map((s) => s.endpoint).sort()).toEqual([
			"https://push.example/ada-laptop",
			"https://push.example/ada-phone",
		]);
		expect(push.sent[0].payload).toEqual({
			title: "Greetings",
			status: "completed",
			url: `/c/${id}`,
		});
	});

	it("says a Run that asked a Question waits for the User", async () => {
		end = "question";
		await conversations.send(ada, { text: "hi" });
		await waitFor(alerts, (a) => a.length === 2);
		expect((await alerts())[0]).toMatchObject({ status: "question" });
	});

	it("sends none for a Run the User stopped, but one for an Unattended Run out of time", async () => {
		end = "hold";
		const id = await conversations.send(ada, { text: "hi" });
		await waitFor(
			() => conversations.get(ada, id),
			(c) => c?.messages.length === 2,
		);
		await conversations.stop(ada, id);
		await waitFor(
			() => conversations.get(ada, id),
			(c) => c?.status === "idle",
		);
		expect(await settled()).toEqual([]);

		config = {
			...base,
			limits: { ...base.limits, unattendedMaxDuration: 1 },
		};
		const taskId = await tasks.create(ada, input());
		expect((await firingOf(taskId)).outcome).toBe("partial");
		await waitFor(alerts, (a) => a.length === 4);
		// the one-time task finished as it fired, and its Run ran out of time
		expect((await alerts()).map((a) => a.status).sort()).toEqual([
			"finished",
			"finished",
			"partial",
			"partial",
		]);
	});

	it("sends one Alert for a Firing whose Run failed, and one for a Firing that failed before its Conversation, which opens the task", async () => {
		end = "fail";
		const failing = await tasks.create(ada, input());
		const fired = await firingOf(failing);
		expect(fired.outcome).toBe("failed");
		const ofRun = (await settled()).filter((a) => a.status === "failed");
		expect(ofRun).toEqual([
			{ title: "News", status: "failed", url: `/c/${fired.conversationId}` },
			{ title: "News", status: "failed", url: `/c/${fired.conversationId}` },
		]);

		push.sent.length = 0;
		const gone = await tasks.create(
			ada,
			input({ name: "Weather", schedule: { kind: "every", seconds: 1 } }),
		);
		config = { ...base, agents: [agent({ pickable: false })] };
		await waitFor(
			() => tasks.get(ada, gone),
			(t) => t?.state === "auto_paused",
		);
		// two failed, then the third auto-paused it: one Alert each, to each browser
		expect((await settled()).map((a) => a.status)).toEqual([
			"failed",
			"failed",
			"failed",
			"failed",
			"auto_paused",
			"auto_paused",
		]);
		expect((await alerts())[0]).toEqual({
			title: "Weather",
			status: "failed",
			url: `/tasks?task=${gone}`,
		});
	});

	it("keeps quiet about completed and partial Runs of a task that has Alerts off, but not about its Questions or its end", async () => {
		const quiet = () => input({ alertOnComplete: false });
		await firingOf(await tasks.create(ada, quiet()));
		await firingOf(await tasks.create(ada, quiet()));
		end = "partial";
		await firingOf(await tasks.create(ada, quiet()));
		expect((await settled()).map((a) => a.status)).toEqual(
			Array(6).fill("finished"),
		);
		push.sent.length = 0;
		end = "question";
		const asked = await firingOf(await tasks.create(ada, quiet()));
		expect(await settled()).toContainEqual({
			title: "Greetings",
			status: "question",
			url: `/c/${asked.conversationId}`,
		});
	});

	it("drops a browser whose push service says it is gone", async () => {
		push.refuse.set("https://push.example/ada-phone", 410);
		push.refuse.set("https://push.example/ada-laptop", 404);
		await subscribe(ada, "https://push.example/ada-tablet");
		push.refuse.set("https://push.example/ada-tablet", 500);
		await conversations.send(ada, { text: "hi" });
		await settled();
		push.refuse.clear();
		await conversations.send(ada, { text: "again" });
		await waitFor(alerts, (a) => a.length === 1);
		expect(await settled()).toHaveLength(1);
		expect(push.sent[0].endpoint).toBe("https://push.example/ada-tablet");
	});

	it("sends nothing and offers no key without VAPID keys", async () => {
		expect(conversations.alerts.publicKey()).toBe("public");
		delete process.env.VAPID_PRIVATE_KEY;
		expect(conversations.alerts.publicKey()).toBeNull();
		const id = await conversations.send(ada, { text: "hi" });
		await waitFor(
			() => conversations.get(ada, id),
			(c) => c?.status === "idle",
		);
		expect(await settled()).toEqual([]);
	});

	it("keeps a browser another User subscribed when the keys are not that browser's", async () => {
		await subscribe("bob", "https://push.example/ada-laptop", "stolen");
		await conversations.send(ada, { text: "hi" });
		await waitFor(alerts, (a) => a.length === 2);
		expect(push.sent.map((s) => s.endpoint).sort()).toEqual([
			"https://push.example/ada-laptop",
			"https://push.example/ada-phone",
		]);
	});

	it("moves a browser to the User signed in on it, and forgets it on unsubscribe", async () => {
		await subscribe("bob", "https://push.example/ada-phone");
		// not Bob's to forget
		await conversations.alerts.unsubscribe(
			"bob",
			"https://push.example/ada-laptop",
		);
		await conversations.send(ada, { text: "hi" });
		await waitFor(alerts, (a) => a.length === 1);
		expect(push.sent.map((s) => s.endpoint)).toEqual([
			"https://push.example/ada-laptop",
		]);
		push.sent.length = 0;
		await conversations.alerts.unsubscribe(
			ada,
			"https://push.example/ada-laptop",
		);
		await conversations.send(ada, { text: "again" });
		expect(await settled()).toEqual([]);
	});
});
