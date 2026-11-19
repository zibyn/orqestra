import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A chat's app (ADR 0020), installed by credentials and taking its events down a held connection, kept in a migrated, throwaway
// Postgres: TEST_DATABASE_URL is wiped before every test. The chat is a fake in memory.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { integrationInstallation } = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { createPostgresBackend, Queue } = await import("bullmq");
const {
	auth,
	credentialsStatus,
	finishLink,
	linkedBy,
	postActivity,
	privateLink,
	queueEvent,
	serveEvents,
	saveCredentials,
	sendPrivateLink,
	serveStream,
	tellPerson,
} = await import("./index.ts");
const { chatEvent, fakeChannel } = await import("./testing.ts");

async function waitFor<T>(read: () => T | Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 200; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Empties a queue: a run before this one's jobs would be taken for its own. */
async function obliterate(name: string) {
	const queue = new Queue(
		name,
		{ connection: { connectionString: url as string } },
		createPostgresBackend,
	);
	await queue.obliterate({ force: true });
	await queue.close();
}

const reset = () =>
	db.execute(
		sql`truncate integration_installation, integration_link_sent, "user" cascade`,
	);

describe.skipIf(!url)("installing a chat's app by credentials", () => {
	beforeEach(reset);
	afterAll(reset);

	it("saves them once the chat accepts them, naming its workspace, and never gives a secret back", async () => {
		const chat = fakeChannel();
		const { source } = chat;
		expect(await credentialsStatus(source)).toEqual({
			fields: [
				{
					name: "appId",
					secret: false,
					optional: false,
					value: "",
					readable: false,
				},
				{
					name: "appSecret",
					secret: true,
					optional: false,
					value: "",
					readable: false,
				},
				{
					name: "region",
					secret: false,
					optional: true,
					value: "",
					readable: false,
				},
			],
			installation: null,
		});
		expect(
			await saveCredentials(source, {
				appId: "cli-1",
				appSecret: "app-s3cret",
			}),
		).toEqual({ errors: {} });
		const status = await credentialsStatus(source);
		expect(status).toEqual({
			fields: [
				{
					name: "appId",
					secret: false,
					optional: false,
					value: "cli-1",
					readable: true,
				},
				{
					name: "appSecret",
					secret: true,
					optional: false,
					value: "",
					readable: true,
				},
				{
					name: "region",
					secret: false,
					optional: true,
					value: "",
					readable: false,
				},
			],
			installation: {
				workspace: "Acme Chat",
				defaultAgentId: null,
				scopeRepos: {},
				openScopes: [],
			},
		});
		const [row] = await db.select().from(integrationInstallation);
		expect(JSON.stringify(row)).not.toMatch(/app-s3cret|tenant-1|cli-1/);
		expect(JSON.stringify(status)).not.toContain("app-s3cret");
	});

	it("asks for each field the first time, keeps a secret left blank, and stores nothing the chat refuses", async () => {
		const chat = fakeChannel();
		const { source } = chat;
		expect(await saveCredentials(source, { appId: "" })).toEqual({
			errors: {
				appId: { code: "required" },
				appSecret: { code: "secret_required" },
			},
		});
		expect(
			await saveCredentials(source, { appId: "cli-1", appSecret: "wrong" }),
		).toEqual({
			errors: {
				"": { code: "credentials_refused", detail: "app secret refused" },
			},
		});
		expect(await db.select().from(integrationInstallation)).toEqual([]);

		await saveCredentials(source, { appId: "cli-1", appSecret: "app-s3cret" });
		expect(
			await saveCredentials(source, { appId: "cli-2", appSecret: "" }),
		).toEqual({ errors: {} });
		expect(chat.trades.at(-1)).toEqual({
			appId: "cli-2",
			appSecret: "app-s3cret",
		});
		expect((await credentialsStatus(source)).fields[0].value).toBe("cli-2");
	});

	it("acts with the token its credentials traded for, trading again only once it is about to expire, one process at a time", async () => {
		const chat = fakeChannel({ tokenTtl: 3_600_000 });
		const { source } = chat;
		expect(await auth(source)).toBeUndefined();
		await saveCredentials(source, { appId: "cli-1", appSecret: "app-s3cret" });
		const credentials = { appId: "cli-1", appSecret: "app-s3cret" };
		// the save's own trade, cached
		expect(await auth(source)).toEqual({ token: "tenant-1", credentials });
		await postActivity(source, "chat-1", { type: "response", body: "Hi" });
		expect(chat.posted).toEqual([
			{
				token: "tenant-1",
				sessionId: "chat-1",
				activity: { type: "response", body: "Hi" },
			},
		]);
		expect(chat.trades).toHaveLength(1);

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 3_600_000);
		try {
			const both = await Promise.all([auth(source), auth(source)]);
			expect(both.map((a) => a?.token)).toEqual(["tenant-2", "tenant-2"]);
			expect(chat.trades).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe.skipIf(!url)("the connection a worker holds to a chat", () => {
	beforeEach(reset);
	afterAll(reset);

	it("connects once the app is installed, again with new credentials, after a refusal, and closes when told to", async () => {
		const chat = fakeChannel();
		const { source } = chat;
		const events: string[] = [];
		const close = serveStream(
			source,
			async (event) => {
				events.push(event.id);
			},
			{ every: 50, backoff: 1000 },
		);
		try {
			await sleep(200);
			expect(chat.connects).toEqual([]);

			await saveCredentials(source, {
				appId: "cli-1",
				appSecret: "app-s3cret",
			});
			await waitFor(
				() => chat.open,
				(n) => n === 1,
			);
			expect(chat.connects.map((c) => c.credentials.appId)).toEqual(["cli-1"]);
			await chat.push(chatEvent({ id: "m1" }));
			expect(events).toEqual(["m1"]);

			await saveCredentials(source, { appId: "cli-2", appSecret: "" });
			await waitFor(
				() => chat.connects.length,
				(n) => n === 2,
			);
			await waitFor(
				() => chat.open,
				(n) => n === 1,
			);
			expect(chat.connects[1].credentials.appId).toBe("cli-2");

			// the chat refuses the next connections: tried again after a second, then two
			chat.refuse = true;
			await saveCredentials(source, { appId: "cli-3", appSecret: "" });
			await waitFor(
				() => chat.connects.length,
				(n) => n === 3,
			);
			expect(chat.open).toBe(0);
			await sleep(700);
			expect(chat.connects).toHaveLength(3);
			chat.refuse = false;
			await waitFor(
				() => chat.open,
				(n) => n === 1,
			);
			expect(chat.connects).toHaveLength(4);
		} finally {
			await close();
		}
		expect(chat.open).toBe(0);
	});

	it("hands the next connection what the last one got to, until the app's credentials change", async () => {
		const chat = fakeChannel();
		const { source } = chat;
		await saveCredentials(source, { appId: "cli-1", appSecret: "app-s3cret" });
		const close = serveStream(source, async () => {}, { every: 50 });
		try {
			const connected = (n: number) =>
				waitFor(
					async () => chat.connects.length === n && chat.open === 1,
					Boolean,
				);
			await connected(1);
			await chat.push(chatEvent({ id: "m1" }));
			// saved again as it was: the same mailbox
			await saveCredentials(source, { appId: "cli-1", appSecret: "" });
			await connected(2);
			await saveCredentials(source, { appId: "cli-2", appSecret: "" });
			await connected(3);
			expect(chat.resumed).toEqual([null, "m1", null]);
		} finally {
			await close();
		}
	});

	it("connects in one worker only for a source that allows one connection, the next taking over once it lets go", async () => {
		const chat = fakeChannel({ exclusive: true });
		const { source } = chat;
		await saveCredentials(source, { appId: "cli-1", appSecret: "app-s3cret" });
		const got: Record<string, string[]> = { a: [], b: [] };
		const serve = (worker: "a" | "b") =>
			serveStream(
				source,
				async (event) => {
					got[worker].push(event.id);
				},
				{ every: 50 },
			);
		const closers = { a: serve("a"), b: serve("b") };
		try {
			await waitFor(
				() => chat.open,
				(n) => n === 1,
			);
			await sleep(400);
			expect(chat.connects).toHaveLength(1);
			await chat.push(chatEvent({ id: "m1" }));
			const holder = got.a.length ? "a" : "b";
			const other = holder === "a" ? "b" : "a";
			expect(got[holder]).toEqual(["m1"]);

			await closers[holder]();
			await waitFor(
				() => chat.connects.length === 2 && chat.open === 1,
				Boolean,
			);
			await chat.push(chatEvent({ id: "m2" }));
			expect(got[other]).toEqual(["m2"]);
		} finally {
			await Promise.all([closers.a(), closers.b()]);
		}
	});

	it("sends what any process posts or tells, for a source that allows one connection, through the worker holding it", async () => {
		const chat = fakeChannel({ exclusive: true });
		const { source } = chat;
		await obliterate("email-posts");
		await saveCredentials(source, { appId: "cli-1", appSecret: "app-s3cret" });
		// queued before any worker holds the connection
		await postActivity(source, "chat-1", { type: "thought", body: "On it." });
		expect(chat.posted).toEqual([]);
		const close = serveStream(source, async () => {}, { every: 50 });
		try {
			await waitFor(
				() => chat.posted.length,
				(n) => n === 1,
			);
			await postActivity(source, "chat-1", { type: "response", body: "Done." });
			await tellPerson(source, { id: "chat-user-1", name: "Uma" }, "A link");
			await waitFor(
				() => chat.posted.length,
				(n) => n === 2,
			);
			expect(chat.posted).toEqual([
				{
					token: "tenant-1",
					sessionId: "chat-1",
					activity: { type: "thought", body: "On it." },
				},
				{
					token: "tenant-1",
					sessionId: "chat-1",
					activity: { type: "response", body: "Done." },
				},
			]);
			expect(chat.told).toEqual([
				{ person: { id: "chat-user-1", name: "Uma" }, body: "A link" },
			]);

			chat.source.proof = {
				mode: "private-link",
				tell: async () => {
					throw new Error("never wrote to the app alone");
				},
			};
			await expect(
				tellPerson(source, { id: "chat-user-2", name: "Ugo" }, "A link"),
			).rejects.toThrow("never wrote to the app alone");
		} finally {
			await close();
		}
	});
});

describe.skipIf(!url)("a private link", () => {
	beforeEach(async () => {
		await reset();
		for (const id of ["u1", "u2"])
			await db.execute(
				sql`insert into "user" (id, name, email, last_active_at) values (${id}, ${id}, ${`${id}@example.com`}, now())`,
			);
	});
	afterAll(reset);

	const accounts = async () =>
		(
			await db.execute<{ external_id: string; user_id: string; name: string }>(
				sql`select external_id, user_id, name from integration_account order by user_id`,
			)
		).rows;
	const linkOf = (href: string) => new URL(href).searchParams.get("link") ?? "";

	it("links whoever opens it signed in to the person it was sent to, one account per User, the last opener taking the person", async () => {
		const { source } = fakeChannel();
		const sent = privateLink(
			source,
			{ id: "chat-user-1", name: "Uma" },
			"https://orqestra.example.com",
		);
		expect(sent).toMatch(
			/^https:\/\/orqestra\.example\.com\/connections\?link=/,
		);
		expect(sent).not.toContain("chat-user-1");
		expect(await finishLink("u1", linkOf(sent))).toBe("email");
		expect(await accounts()).toEqual([
			{ external_id: "chat-user-1", user_id: "u1", name: "Uma" },
		]);

		const other = privateLink(source, { id: "chat-user-2", name: "Ugo" });
		expect(other.startsWith("/connections?link=")).toBe(true);
		await finishLink(
			"u1",
			new URLSearchParams(other.split("?")[1]).get("link") ?? "",
		);
		expect(await accounts()).toEqual([
			{ external_id: "chat-user-2", user_id: "u1", name: "Ugo" },
		]);
		await finishLink("u2", linkOf(sent));
		expect(await accounts()).toEqual([
			{ external_id: "chat-user-2", user_id: "u1", name: "Ugo" },
			{ external_id: "chat-user-1", user_id: "u2", name: "Uma" },
		]);
	});

	it("says who it links without linking them, for the User to confirm", async () => {
		const { source } = fakeChannel();
		const sent = linkOf(
			privateLink(
				source,
				{ id: "chat-user-1", name: "Uma" },
				"https://o.example",
			),
		);
		expect(linkedBy(sent)).toEqual({ kind: "email", name: "Uma" });
		expect(linkedBy("guessed")).toBeUndefined();
		expect(await accounts()).toEqual([]);
	});

	it("is sent a person at most once in ten minutes however many workers ask, unless it could not be sent", async () => {
		const { source } = fakeChannel();
		const uma = { id: "chat-user-1", name: "Uma" };
		const told: string[] = [];
		const tell = async (link: string) => {
			told.push(link);
		};
		const both = await Promise.all([
			sendPrivateLink(source, uma, tell),
			sendPrivateLink(source, uma, tell),
		]);
		expect(both.sort()).toEqual([false, true]);
		expect(told).toHaveLength(1);
		expect(
			await sendPrivateLink(source, { id: "chat-user-2", name: "Ugo" }, tell),
		).toBe(true);

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
		try {
			const refused = new Error("never wrote to the app alone");
			await expect(
				sendPrivateLink(source, uma, async () => {
					throw refused;
				}),
			).rejects.toBe(refused);
			expect(await sendPrivateLink(source, uma, tell)).toBe(true);
			expect(await sendPrivateLink(source, uma, tell)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
		expect(told).toHaveLength(3);
	});

	it("links nobody once it is ten minutes old, or when it is not one Orqestra sealed", async () => {
		const { source } = fakeChannel();
		const sent = linkOf(
			privateLink(
				source,
				{ id: "chat-user-1", name: "Uma" },
				"https://o.example",
			),
		);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
		try {
			expect(await finishLink("u1", sent)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
		expect(await finishLink("u1", `${sent.slice(0, -4)}AAA=`)).toBeUndefined();
		expect(await finishLink("u1", "guessed")).toBeUndefined();
		expect(await accounts()).toEqual([]);
	});
});

describe.skipIf(!url)("a chat's queued events", () => {
	it("queues each once under its own id, however it is spelled, a Message-ID's colons and an integer included", async () => {
		const { source } = fakeChannel();
		await obliterate("email-events");
		const taken: string[] = [];
		const worker = await serveEvents(source, async (event) => {
			taken.push(event.id);
		});
		try {
			const ids = ["<a1:b2@mail.example>", "42", "#42", "created-7"];
			for (const id of [...ids, ...ids])
				await queueEvent(source, chatEvent({ id }));
			await waitFor(
				() => taken.length,
				(n) => n >= ids.length,
			);
			await sleep(300);
			expect(taken.sort()).toEqual([...ids].sort());
		} finally {
			await worker.close();
		}
	});
});
