import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { live } from "./live.ts";
import * as schema from "./schema.ts";
import { provider } from "./schema.ts";

// Against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;

// a write reloads asynchronously in other processes
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 50; i++) {
		const value = await read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("live (Postgres)", () => {
	const db = drizzle(url as string, { schema });
	const ids = () =>
		db
			.select({ id: provider.id })
			.from(provider)
			.then((rows) => rows.map((r) => r.id).sort());
	// one per process, as the api and the worker each have their own
	const opened: { close(): Promise<unknown> }[] = [];
	// another process has its own pool
	const other = drizzle(url as string, { schema });
	const open = <T>(load: () => Promise<T>, on = db) => {
		const l = live(on, { channel: "live_test", load });
		opened.push(l);
		return l;
	};

	beforeEach(() => db.execute(sql`truncate provider cascade`));
	afterAll(async () => {
		await Promise.all(opened.map((l) => l.close()));
		await db.execute(sql`truncate provider cascade`);
		await Promise.all([db.$client.end(), other.$client.end()]);
	});

	it("loads once and serves the cached snapshot", async () => {
		let loads = 0;
		const l = open(() => ids().finally(() => loads++));
		expect(await l.current()).toEqual([]);
		await l.current();
		expect(loads).toBe(1);
	});

	it("sees its own write once write resolves, with what fn returned", async () => {
		const l = open(ids);
		await l.current();
		const [row] = await l.write((tx) =>
			tx.insert(provider).values({ id: "a", apiKey: "k" }).returning(),
		);
		expect(row.id).toBe("a");
		expect(await l.current()).toEqual(["a"]);
	});

	it("reloads in every other process after a write is committed", async () => {
		const here = open(ids);
		const elsewhere = open(ids, other);
		expect(await elsewhere.current()).toEqual([]);
		await here.write((tx) =>
			tx.insert(provider).values({ id: "a", apiKey: "k" }),
		);
		await eventually(
			() => elsewhere.current(),
			(v) => v.includes("a"),
		);
	});

	it("reloads only the lives of the channel written to", async () => {
		let others = 0;
		const mine = open(ids);
		const theirs = live(db, {
			channel: "live_test_other",
			load: async () => others++,
		});
		try {
			await Promise.all([mine.current(), theirs.current()]);
			await mine.write((tx) =>
				tx.insert(provider).values({ id: "a", apiKey: "k" }),
			);
			expect(await mine.current()).toEqual(["a"]);
			expect(others).toBe(1);
		} finally {
			await theirs.close();
		}
	});

	it("does not reload when the write rolls back", async () => {
		const l = open(ids);
		await l.current();
		await expect(
			l.write(async (tx) => {
				await tx.insert(provider).values({ id: "a", apiKey: "k" });
				throw new Error("no");
			}),
		).rejects.toThrow("no");
		expect(await l.current()).toEqual([]);
	});

	it("keeps the previous snapshot when a reload fails", async () => {
		let fail = false;
		const l = open(() => (fail ? Promise.reject(new Error("bad")) : ids()));
		expect(await l.current()).toEqual([]);
		fail = true;
		await l.write((tx) => tx.insert(provider).values({ id: "a", apiKey: "k" }));
		expect(await l.current()).toEqual([]);
	});

	it("rejects current() when the first load fails", async () => {
		const l = open(() => Promise.reject(new Error("bad config")));
		await expect(l.current()).rejects.toThrow("bad config");
	});
});
