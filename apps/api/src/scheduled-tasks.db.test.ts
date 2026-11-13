import { beforeEach, describe, expect, it } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import {
	createConversations,
	DEFAULT_LIMITS,
	type Snapshots,
} from "@orqestra/conversations";
import { noMcpServerDeletes } from "@orqestra/conversations/testing";
import { db } from "@orqestra/db";
import { memoryStore } from "@orqestra/tools/testing";
import { createApp, type User } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL, wiped before every test (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const agent = (id: string, pickable = true) =>
	({
		id,
		name: id,
		description: "test Agent",
		instructions: "",
		models: ["faux/faux-1"],
		defaultModel: "faux/faux-1",
		thinking: {},
		default: id === "faux",
		memory: false,
		pickable,
		allModels: false,
		tools: [],
		skills: [],
		unavailableModels: [],
	}) as AgentDefinition;
const config = {
	agents: [agent("faux"), agent("template", false)],
	models: faux.models,
	defaultAgent: agent("faux"),
	skills: {},
	limits: DEFAULT_LIMITS,
} as unknown as Snapshots;
const conversations = createConversations({
	store: memoryStore().store,
	capabilities: {
		...noMcpServerDeletes,
		current: async () => config,
		skillFiles: async () => [],
	},
});

const ada: User = { id: "ada", name: "Ada", admin: false };
const admin: User = { id: "root", name: "Root", admin: true };

function app(user: User | null) {
	const api = createApp({
		config: createCapabilities(db),
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(),
		conversations,
	});
	return async (method: string, path: string, body?: unknown) => {
		const response = await api.handle(
			new Request(`http://localhost${path}`, {
				method,
				...(body !== undefined && {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			body: text ? JSON.parse(text) : undefined,
		};
	};
}

// paused, so nothing is queued: these tests need no worker
const input = {
	name: "News",
	prompt: "Summarize the news",
	agentId: "faux",
	model: "faux/faux-1",
	thinking: "off",
	schedule: { kind: "cron", expr: "0 9 * * 1-5" },
	endsAt: null,
	timeZone: "Asia/Shanghai",
	incognito: false,
	alertOnComplete: true,
	enabled: false,
};

describe.skipIf(!url)("Scheduled Tasks through the api", () => {
	beforeEach(async () => {
		await db.$client.query("truncate conversation, scheduled_task cascade");
	});

	it("is 401 without a User", async () => {
		const { status } = await app(null)("POST", "/api/scheduled-tasks", input);
		expect(status).toBe(401);
	});

	it("saves a task the User then sees, and nobody else, Admins included", async () => {
		const created = await app(ada)("POST", "/api/scheduled-tasks", input);
		expect(created.status).toBe(200);
		const { id } = created.body;
		const listed = await app(ada)("GET", "/api/scheduled-tasks");
		expect(listed.body).toMatchObject([
			{ id, name: "News", state: "paused", next: null, last: null },
		]);
		expect((await app(admin)("GET", "/api/scheduled-tasks")).body).toEqual([]);
		for (const [method, path, body] of [
			["GET", `/api/scheduled-tasks/${id}`],
			["PUT", `/api/scheduled-tasks/${id}`, input],
			["PUT", `/api/scheduled-tasks/${id}/enabled`, { enabled: false }],
			["DELETE", `/api/scheduled-tasks/${id}`],
		] as const)
			expect(await app(admin)(method, path, body)).toEqual({
				status: 404,
				body: { errors: { task: { code: "not_found" } } },
			});
		expect(
			(await app(ada)("GET", `/api/scheduled-tasks/${id}`)).body,
		).toMatchObject({ id, firings: [] });
		expect(
			(await app(ada)("DELETE", `/api/scheduled-tasks/${id}`)).status,
		).toBe(200);
	});

	it("refuses a task it may not save with 422, naming the field", async () => {
		const refused = await app(ada)("POST", "/api/scheduled-tasks", {
			...input,
			schedule: { kind: "every", seconds: 60 },
		});
		expect(refused).toEqual({
			status: 422,
			body: { errors: { "schedule.seconds": { code: "too_frequent" } } },
		});
		const unpickable = await app(ada)("POST", "/api/scheduled-tasks", {
			...input,
			agentId: "template",
		});
		expect(unpickable.body).toEqual({
			errors: { agentId: { code: "agent_not_pickable" } },
		});
		const shape = await app(ada)("POST", "/api/scheduled-tasks", {
			...input,
			schedule: { kind: "weekly" },
		});
		expect(shape.status).toBe(422);
	});
});
