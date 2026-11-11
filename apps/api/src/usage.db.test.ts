import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { catalogProviders } from "@orqestra/config";
import { config } from "@orqestra/config/live";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { usage, user } from "@orqestra/db/schema";
import { sql } from "drizzle-orm";
import { createApp, type User } from "./app.ts";

// Needs a migrated, throwaway Postgres at TEST_DATABASE_URL (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const ada: User = { id: "ada", name: "Ada", admin: false };
const bob: User = { id: "bob", name: "Bob", admin: false };
const root: User = { id: "root", name: "Root", admin: true };

async function call(user: User | null, path: string) {
	const api = createApp({
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(null, { status: 404 }),
		conversations: {} as Conversations,
	});
	const response = await api.handle(new Request(`http://localhost/api${path}`));
	return {
		status: response.status,
		body: (await response.json()) as {
			rows: Record<string, unknown>[];
			status?: Record<string, unknown> | null;
		},
	};
}

// a Provider from the Catalog with two of its Models
const [catalog] = await catalogProviders();
const [m1, m2] = catalog?.models ?? [];

/** A Usage row of user's at time, the rest made up. */
const used = (
	userId: string,
	at: string,
	row: Partial<typeof usage.$inferInsert> = {},
) =>
	db.insert(usage).values({
		userId,
		agentId: "general",
		agentName: "General",
		provider: catalog?.id ?? "",
		modelId: m1?.id ?? "",
		conversationId: crypto.randomUUID(),
		purpose: "step",
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 1,
		cacheWriteTokens: 2,
		cost: 0.5,
		createdAt: new Date(at),
		...row,
	});

const range = (from: string, to: string) =>
	`from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
const january = range("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

describe.skipIf(!url)("/api/usage/mine", () => {
	const reset = async () => {
		await db.execute(
			sql`truncate usage, provider, enabled_model, agent, limits, "user" cascade`,
		);
		await config.agents.save({
			id: "general",
			create: true,
			definition: {
				name: "General",
				description: "d",
				instructions: "",
				default: true,
			},
		});
	};
	beforeEach(reset);
	afterAll(reset);

	it("sums a Member's own Usage only, by Model", async () => {
		await used("ada", "2026-01-05T00:00:00Z");
		await used("ada", "2026-01-06T00:00:00Z", { cost: 0.25 });
		await used("ada", "2026-01-06T00:00:00Z", { modelId: m2?.id, cost: 1 });
		await used("bob", "2026-01-06T00:00:00Z", { cost: 9 });
		const { status, body } = await call(
			ada,
			`/usage/mine?${january}&group=model`,
		);
		expect(status).toBe(200);
		expect(body.rows).toEqual([
			{
				key: `${catalog?.id}/${m2?.id}`,
				name: m2?.name,
				disabled: true,
				requests: 1,
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 1,
				cacheWriteTokens: 2,
				cost: 1,
			},
			{
				key: `${catalog?.id}/${m1?.id}`,
				name: m1?.name,
				disabled: true,
				requests: 2,
				inputTokens: 20,
				outputTokens: 40,
				cacheReadTokens: 2,
				cacheWriteTokens: 4,
				cost: 0.75,
			},
		]);
		expect(
			(await call(bob, `/usage/mine?${january}&group=model`)).body.rows,
		).toMatchObject([{ requests: 1, cost: 9 }]);
	});

	it("adds the User's Spending Limit this month, whatever the range, and nothing without one", async () => {
		await used("ada", new Date().toISOString(), { cost: 3 });
		const mine = async () =>
			(await call(ada, `/usage/mine?${january}&group=model`)).body;
		expect((await mine()).status).toBeNull();
		await db.execute(
			sql`insert into "user" (id, name, last_active_at, spending_limit) values ('ada', 'Ada', now(), '{"mode":"limited","usd":5}')`,
		);
		expect((await mine()).status).toMatchObject({
			spent: 3,
			usd: 5,
			reached: false,
			resetTimeZone: "UTC",
		});
	});

	it("counts a range from its start up to, not including, its end", async () => {
		// a day in UTC+8, as a browser there works it out
		const day = range("2026-01-05T00:00:00+08:00", "2026-01-06T00:00:00+08:00");
		await used("ada", "2026-01-04T15:59:59.999Z", { cost: 1 });
		await used("ada", "2026-01-04T16:00:00Z", { cost: 2 });
		await used("ada", "2026-01-05T15:59:59.999Z", { cost: 4 });
		await used("ada", "2026-01-05T16:00:00Z", { cost: 8 });
		expect(
			(await call(ada, `/usage/mine?${day}&group=model`)).body.rows,
		).toMatchObject([{ requests: 2, cost: 6 }]);
	});

	it("groups by Agent: the general worker apart, a deleted one marked", async () => {
		await config.agents.save({
			id: "writer",
			create: true,
			definition: { name: "Writer", description: "d", instructions: "" },
		});
		await used("ada", "2026-01-05T00:00:00Z", { cost: 4 });
		await used("ada", "2026-01-05T00:00:00Z", {
			agentId: null,
			agentName: null,
			cost: 3,
		});
		await used("ada", "2026-01-05T00:00:00Z", {
			agentId: "gone",
			agentName: "Old name",
			cost: 1,
		});
		await used("ada", "2026-01-06T00:00:00Z", {
			agentId: "gone",
			agentName: "Gone",
			cost: 1,
		});
		await used("ada", "2026-01-06T00:00:00Z", {
			agentId: "writer",
			agentName: "Writer",
			cost: 0.5,
		});
		const rows = (await call(ada, `/usage/mine?${january}&group=agent`)).body
			.rows;
		expect(
			rows.map((r: Record<string, unknown>) => [
				r.key,
				r.name,
				r.deleted,
				r.cost,
			]),
		).toEqual([
			["general", "General", false, 4],
			[null, null, false, 3],
			["gone", "Gone", true, 2],
			["writer", "Writer", false, 0.5],
		]);
	});

	it("drills down: an Agent's Usage by Model, the general worker's too", async () => {
		await used("ada", "2026-01-05T00:00:00Z", { cost: 4 });
		await used("ada", "2026-01-05T00:00:00Z", { modelId: m2?.id, cost: 2 });
		await used("ada", "2026-01-05T00:00:00Z", {
			agentId: null,
			agentName: null,
			cost: 1,
		});
		const general = await call(
			ada,
			`/usage/mine?${january}&group=model&agent=general`,
		);
		expect(general.body.rows).toMatchObject([{ cost: 4 }, { cost: 2 }]);
		const worker = await call(ada, `/usage/mine?${january}&group=model&agent=`);
		expect(worker.body.rows).toMatchObject([{ cost: 1 }]);
		const model = encodeURIComponent(`${catalog?.id}/${m2?.id}`);
		const byModel = await call(
			ada,
			`/usage/mine?${january}&group=agent&model=${model}`,
		);
		expect(byModel.body.rows).toMatchObject([{ key: "general", cost: 2 }]);
	});

	it("shows an enabled Model as not disabled", async () => {
		await config.providers.save({
			id: catalog?.id ?? "",
			apiKey: "k",
			baseUrl: catalog?.baseUrl ?? "",
		});
		await config.providers.setModelEnabled({
			providerId: catalog?.id ?? "",
			modelId: m1?.id ?? "",
			enabled: true,
		});
		await used("ada", "2026-01-05T00:00:00Z");
		expect(
			(await call(ada, `/usage/mine?${january}&group=model`)).body.rows,
		).toMatchObject([{ name: m1?.name, disabled: false }]);
	});

	it("is for signed-in Users, and refuses a bad range or group", async () => {
		expect(
			(await call(null, `/usage/mine?${january}&group=model`)).status,
		).toBe(401);
		expect((await call(ada, `/usage/mine?${january}&group=user`)).status).toBe(
			422,
		);
		expect(
			(await call(ada, "/usage/mine?from=yesterday&to=now&group=model")).status,
		).toBe(422);
	});
});

describe.skipIf(!url)("/api/usage", () => {
	const reset = async () => {
		await db.execute(
			sql`truncate usage, provider, enabled_model, agent, "user" cascade`,
		);
	};
	beforeEach(reset);
	afterAll(reset);

	it("sums every User's Usage, each by their current name", async () => {
		await db.insert(user).values([
			{ id: "ada", name: "Ada Lovelace", lastActiveAt: new Date() },
			{ id: "bob", name: "Bob", lastActiveAt: new Date() },
		]);
		await used("ada", "2026-01-05T00:00:00Z");
		await used("ada", "2026-01-06T00:00:00Z", { cost: 0.25 });
		await used("bob", "2026-01-06T00:00:00Z", { cost: 9 });
		const { status, body } = await call(root, `/usage?${january}&group=user`);
		expect(status).toBe(200);
		expect(body.rows).toEqual([
			{
				key: "bob",
				name: "Bob",
				requests: 1,
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 1,
				cacheWriteTokens: 2,
				cost: 9,
			},
			{
				key: "ada",
				name: "Ada Lovelace",
				requests: 2,
				inputTokens: 20,
				outputTokens: 40,
				cacheReadTokens: 2,
				cacheWriteTokens: 4,
				cost: 0.75,
			},
		]);
	});

	it("drills down: a User by Agent or Model, an Agent or Model by User", async () => {
		await used("ada", "2026-01-05T00:00:00Z", { cost: 4 });
		await used("ada", "2026-01-05T00:00:00Z", {
			agentId: null,
			agentName: null,
			modelId: m2?.id,
			cost: 2,
		});
		await used("bob", "2026-01-05T00:00:00Z", {
			agentId: "gone",
			agentName: "Gone",
			cost: 1,
		});
		const rows = async (q: string) =>
			(await call(root, `/usage?${january}&${q}`)).body.rows;

		expect(await rows("group=agent&user=ada")).toMatchObject([
			{ key: "general", deleted: true, cost: 4 },
			{ key: null, name: null, deleted: false, cost: 2 },
		]);
		expect(await rows("group=model&user=ada")).toMatchObject([
			{ key: `${catalog?.id}/${m1?.id}`, disabled: true, cost: 4 },
			{ key: `${catalog?.id}/${m2?.id}`, disabled: true, cost: 2 },
		]);
		expect(await rows("group=agent")).toMatchObject([
			{ key: "general", cost: 4 },
			{ key: null, cost: 2 },
			{ key: "gone", name: "Gone", deleted: true, cost: 1 },
		]);
		expect(await rows("group=user&agent=")).toMatchObject([
			{ key: "ada", name: "ada", cost: 2 },
		]);
		const model = encodeURIComponent(`${catalog?.id}/${m1?.id}`);
		expect(await rows(`group=user&model=${model}`)).toMatchObject([
			{ key: "ada", cost: 4 },
			{ key: "bob", cost: 1 },
		]);
		expect(
			await rows(`group=model&user=ada&agent=general&model=${model}`),
		).toMatchObject([{ requests: 1, cost: 4 }]);
	});

	it("counts a range from its start up to, not including, its end", async () => {
		const day = range("2026-01-05T00:00:00+08:00", "2026-01-06T00:00:00+08:00");
		await used("ada", "2026-01-04T15:59:59.999Z", { cost: 1 });
		await used("bob", "2026-01-04T16:00:00Z", { cost: 2 });
		await used("ada", "2026-01-05T15:59:59.999Z", { cost: 4 });
		await used("bob", "2026-01-05T16:00:00Z", { cost: 8 });
		expect(
			(await call(root, `/usage?${day}&group=user`)).body.rows,
		).toMatchObject([
			{ key: "ada", cost: 4 },
			{ key: "bob", cost: 2 },
		]);
	});

	it("is for Admins only", async () => {
		expect((await call(ada, `/usage?${january}&group=user`)).status).toBe(403);
		expect((await call(null, `/usage?${january}&group=user`)).status).toBe(401);
	});
});
