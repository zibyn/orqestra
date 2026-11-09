import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { config } from "@orqestra/config/live";
import { SKILL_ZIP_MAX_BYTES } from "@orqestra/config/shared";
import { zip } from "@orqestra/config/test-zip";
import type { Conversations } from "@orqestra/conversations";
import { createApp, type User } from "./app.ts";

const ada: User = { id: "s1", name: "Ada", admin: true };
const bob: User = { id: "s2", name: "Bob", admin: false };

/** The app as user; reads counts session reads. */
function app(user: User | null) {
	const reads: Request[] = [];
	const api = createApp({
		session: async (request) => {
			reads.push(request);
			return { user, cookies: [] };
		},
		auth: () => new Response(),
		conversations: {} as Conversations,
	});
	return { handle: (request: Request) => api.handle(request), reads };
}

const url = (path: string) => `http://localhost/api/skills${path}`;
const json = (method: string, path: string, body?: unknown) =>
	new Request(url(path), {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

/** A zip body that records whether it was read. */
function body(bytes: Uint8Array) {
	const state = { read: false };
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				state.read = true;
				c.enqueue(bytes);
				c.close();
			},
		},
		// pulled only when read
		{ highWaterMark: 0 },
	);
	return { stream, state };
}
const upload = (
	content: ReadableStream<Uint8Array> | Uint8Array,
	query = "",
	headers = {},
) =>
	new Request(url(query), {
		method: "POST",
		headers: { "content-type": "application/zip", ...headers },
		body: content,
	});

const skillZip = (name: string, description: string, extra = {}) =>
	zip([
		{
			path: `${name}/SKILL.md`,
			content: `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
		},
		...Object.entries(extra).map(([path, content]) => ({
			path: `${name}/${path}`,
			content: content as string,
		})),
	]);

describe("/api/skills for anyone but an Admin", () => {
	it("is 401 without a User and 403 for a Member, the zip unread", async () => {
		for (const [user, status, code] of [
			[null, 401, "unauthorized"],
			[bob, 403, "forbidden"],
		] as const) {
			const { stream, state } = body(new Uint8Array([1]));
			const response = await app(user).handle(upload(stream));
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({
				errors: { session: { code } },
			});
			expect(state.read).toBe(false);
			for (const request of [
				json("GET", ""),
				json("PUT", "/pdf/enabled", { enabled: false }),
				json("DELETE", "/pdf"),
			])
				expect((await app(user).handle(request)).status).toBe(status);
		}
	});

	it("reads the session once per request", async () => {
		const { handle, reads } = app(bob);
		await handle(json("GET", ""));
		expect(reads).toHaveLength(1);
	});
});

describe("an oversized zip", () => {
	it("is refused by its declared length before it is read", async () => {
		const { stream, state } = body(new Uint8Array([1]));
		const response = await app(ada).handle(
			upload(stream, "", { "content-length": String(SKILL_ZIP_MAX_BYTES + 1) }),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			errors: { file: { code: "skill_too_large" } },
		});
		expect(state.read).toBe(false);
	});

	it("is refused as it comes when its length is not declared", async () => {
		const { stream } = body(new Uint8Array(SKILL_ZIP_MAX_BYTES + 1));
		const response = await app(ada).handle(upload(stream));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			errors: { file: { code: "skill_too_large" } },
		});
	});
});

const db = process.env.TEST_DATABASE_URL;

describe.skipIf(!db)("an Admin's Skills (Postgres)", () => {
	const { handle } = app(ada);
	const send = async (request: Request) => {
		const response = await handle(request);
		return { status: response.status, body: await response.json() };
	};
	// as listed, dates as strings
	const list = async () =>
		(await send(json("GET", ""))).body as Awaited<
			ReturnType<typeof config.skills.list>
		>;
	const reset = async () => {
		for (const s of await config.skills.list())
			await config.skills.delete(s.name);
	};
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await config.close();
	});

	it("uploads a zip, and refuses an invalid one with 422", async () => {
		expect(await send(upload(skillZip("pdf", "Fills PDFs")))).toEqual({
			status: 200,
			body: { errors: {}, name: "pdf" },
		});
		expect(await list()).toMatchObject([
			{ name: "pdf", description: "Fills PDFs", enabled: true },
		]);
		expect(await send(upload(zip([])))).toEqual({
			status: 422,
			body: { errors: { file: { code: "skill_md_missing" } } },
		});
	});

	it("asks before replacing a name that exists, then adds a version", async () => {
		await send(upload(skillZip("pdf", "v1")));
		expect(await send(upload(skillZip("pdf", "v2")))).toEqual({
			status: 422,
			body: { errors: { name: { code: "skill_exists" } }, name: "pdf" },
		});
		expect(
			(await send(upload(skillZip("pdf", "v2"), "?replace=true"))).status,
		).toBe(200);
		const [pdf] = await list();
		expect(pdf.description).toBe("v2");
		expect(pdf.versions.map((v) => v.number)).toEqual([2, 1]);
	});

	it("edits a version's files into a new one, and refuses an invalid edit with 422", async () => {
		await send(upload(skillZip("pdf", "v1", { "a.py": "print(1)" })));
		const [{ currentVersionId: base }] = await list();
		expect((await send(json("GET", `/versions/${base}/files`))).body).toEqual([
			{
				path: "SKILL.md",
				size: 39,
				text: "---\nname: pdf\ndescription: v1\n---\nBody\n",
			},
			{ path: "a.py", size: 8, text: "print(1)" },
		]);
		const md = "---\nname: pdf\ndescription: v2\n---\n";
		expect(
			await send(
				json("POST", "/pdf/versions", {
					base,
					files: [{ path: "SKILL.md", text: md }, { path: "a.py" }],
				}),
			),
		).toEqual({ status: 200, body: { errors: {} } });
		const [pdf] = await list();
		expect(pdf.description).toBe("v2");
		const edited = await send(
			json("GET", `/versions/${pdf.currentVersionId}/files`),
		);
		expect((edited.body as { path: string }[]).map((f) => f.path)).toEqual([
			"SKILL.md",
			"a.py",
		]);
		expect(
			await send(json("POST", "/pdf/versions", { base, files: [] })),
		).toEqual({
			status: 422,
			body: { errors: { file: { code: "skill_md_missing" } } },
		});
	});

	it("rolls back to an earlier version", async () => {
		await send(upload(skillZip("pdf", "v1")));
		await send(upload(skillZip("pdf", "v2"), "?replace=true"));
		const [{ versions }] = await list();
		expect(
			(await handle(json("PUT", "/pdf/current", { versionId: versions[1].id })))
				.status,
		).toBe(200);
		expect((await list())[0]).toMatchObject({
			description: "v1",
			currentVersionId: versions[1].id,
		});
	});

	it("is 404 for a Skill or version that is gone", async () => {
		await send(upload(skillZip("pdf", "v1")));
		const [{ currentVersionId: base }] = await list();
		for (const [request, field] of [
			[json("PUT", "/gone/enabled", { enabled: false }), "name"],
			[json("PUT", "/pdf/current", { versionId: 0 }), "versionId"],
			[json("POST", "/gone/versions", { base, files: [] }), "base"],
		] as const)
			expect(await send(request)).toEqual({
				status: 404,
				body: { errors: { [field]: { code: "not_found" } } },
			});
	});

	it("creates, disables and deletes a Skill", async () => {
		expect(
			await send(json("PUT", "/pdf", { description: "Fills PDFs" })),
		).toEqual({ status: 200, body: { errors: {} } });
		expect(await send(json("PUT", "/pdf", { description: "again" }))).toEqual({
			status: 422,
			body: { errors: { name: { code: "skill_exists" } } },
		});
		await handle(json("PUT", "/pdf/enabled", { enabled: false }));
		expect((await list())[0]).toMatchObject({ name: "pdf", enabled: false });
		await handle(json("DELETE", "/pdf"));
		expect(await list()).toEqual([]);
	});
});
