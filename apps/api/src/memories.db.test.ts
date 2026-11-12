import { beforeEach, describe, expect, it } from "bun:test";
import {
	type Conversations,
	createCapabilities,
} from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { memory } from "@orqestra/db/schema";
import { createApp, type User } from "./app.ts";

// Needs a migrated, throwaway Postgres at TEST_DATABASE_URL (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const ada: User = { id: "ada", name: "Ada", admin: true };
const bob: User = { id: "bob", name: "Bob", admin: false };

/** A request to the api as user, or signed out with null. */
function call(user: User | null, method: string, path: string, body?: unknown) {
	const api = createApp({
		config: createCapabilities(db),
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(null, { status: 404 }),
		conversations: {} as Conversations,
	});
	return api.handle(
		new Request(`http://localhost/api${path}`, {
			method,
			...(body !== undefined && {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		}),
	);
}

const memories = async (user: User) =>
	(await call(user, "GET", "/memories")).json() as Promise<{
		memories: { path: string }[];
		on: boolean;
	}>;
const paths = async (user: User) =>
	(await memories(user)).memories.map((m) => m.path);

describe.skipIf(!url)("/api/memories", () => {
	beforeEach(async () => {
		await db.$client.query("truncate memory, memory_setting cascade");
		await db.insert(memory).values([
			{ userId: ada.id, path: "ada/pets", description: "Pets", body: "a cat" },
			{ userId: bob.id, path: "bob/pets", description: "Pets", body: "a dog" },
		]);
	});

	it("lists the User's own Memories, their switch and the limits", async () => {
		const response = await call(ada, "GET", "/memories");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			memories: [
				{
					path: "ada/pets",
					description: "Pets",
					body: "a cat",
					conversation: null,
				},
			],
			on: true,
			limits: { description: 150, body: 4096 },
		});
	});

	it("is 401 without a User", async () => {
		for (const [method, path, body] of [
			["GET", "/memories"],
			["PUT", "/memories", { path: "ada/pets", description: "", body: "" }],
			["DELETE", "/memories/ada%2Fpets"],
			["DELETE", "/memories"],
			["PUT", "/memories/on", { on: false }],
		] as const) {
			const response = await call(null, method, path, body);
			expect(response.status).toBe(401);
		}
	});

	it("saves a Memory's description and body", async () => {
		const response = await call(ada, "PUT", "/memories", {
			path: "ada/pets",
			description: "Animals",
			body: "two cats",
		});
		expect(response.status).toBe(204);
		expect((await memories(ada)).memories).toMatchObject([
			{ path: "ada/pets", description: "Animals", body: "two cats" },
		]);
	});

	it("refuses a Memory over the limits with 422", async () => {
		const response = await call(ada, "PUT", "/memories", {
			path: "ada/pets",
			description: "Pets",
			body: "x".repeat(4097),
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			errors: {
				"": {
					code: "invalid",
					detail: expect.stringContaining("4097 bytes"),
				},
			},
		});
	});

	it("deletes one Memory, or all of them", async () => {
		await db.insert(memory).values({
			userId: ada.id,
			path: "ada/food",
			description: "Food",
			body: "pasta",
		});
		const one = await call(
			ada,
			"DELETE",
			`/memories/${encodeURIComponent("ada/pets")}`,
		);
		expect(one.status).toBe(204);
		expect(await paths(ada)).toEqual(["ada/food"]);
		const all = await call(ada, "DELETE", "/memories");
		expect(all.status).toBe(204);
		expect(await paths(ada)).toEqual([]);
		expect(await paths(bob)).toEqual(["bob/pets"]);
	});

	it("turns memory off and on", async () => {
		expect((await call(ada, "PUT", "/memories/on", { on: false })).status).toBe(
			204,
		);
		expect((await memories(ada)).on).toBe(false);
		expect((await memories(bob)).on).toBe(true);
		await call(ada, "PUT", "/memories/on", { on: true });
		expect((await memories(ada)).on).toBe(true);
	});

	it("never shows or changes another User's Memories: 404 as if absent", async () => {
		expect(await paths(ada)).toEqual(["ada/pets"]);
		const save = await call(ada, "PUT", "/memories", {
			path: "bob/pets",
			description: "Mine now",
			body: "",
		});
		expect(save.status).toBe(404);
		expect(await save.json()).toEqual({
			errors: { path: { code: "not_found" } },
		});
		const remove = await call(
			ada,
			"DELETE",
			`/memories/${encodeURIComponent("bob/pets")}`,
		);
		expect(remove.status).toBe(404);
		await call(ada, "DELETE", "/memories");
		expect((await memories(bob)).memories).toMatchObject([
			{ path: "bob/pets", description: "Pets", body: "a dog" },
		]);
	});
});
