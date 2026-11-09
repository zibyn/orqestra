import { describe, expect, it } from "vitest";
import {
	frameEnd,
	OrreryError,
	orrery,
	testSandboxProvider,
} from "./orrery.ts";

type Sent = {
	method: string;
	url: string;
	auth: string | null;
	body: unknown;
};

/** An orrery API answering `reply` for every request; records what it was sent. */
function fakeOrrery(reply: (sent: Sent) => Response | Promise<Response>) {
	const sent: Sent[] = [];
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const body = init?.body;
		const request = {
			method: init?.method ?? "GET",
			url: String(input),
			auth: new Headers(init?.headers).get("authorization"),
			body:
				typeof body === "string"
					? JSON.parse(body)
					: body instanceof Uint8Array
						? new TextDecoder().decode(body)
						: body,
		};
		sent.push(request);
		if (init?.signal?.aborted) throw init.signal.reason;
		return reply(request);
	};
	return { fetch, sent };
}

const problem = (status: number, code: string, detail: string) =>
	Response.json(
		{ title: "x", status, code, detail },
		{ status, headers: { "content-type": "application/problem+json" } },
	);

const sandbox = { id: "sb1", state: "pending", cause: null };

describe("orrery client", () => {
	it("creates a Sandbox under /api/v1 with the API Token", async () => {
		const fake = fakeOrrery(() => Response.json(sandbox, { status: 201 }));
		const client = orrery({
			url: "http://orrery.internal/",
			token: "orr_1_s",
			fetch: fake.fetch,
		});
		const created = await client.createSandbox({
			cpu: 2,
			memory: 2 * 1024 ** 3,
			snapshot: "skills",
		});
		expect(created).toEqual(sandbox);
		expect(fake.sent).toEqual([
			{
				method: "POST",
				url: "http://orrery.internal/api/v1/sandboxes",
				auth: "Bearer orr_1_s",
				body: { cpu: 2, memory: 2147483648, snapshot: "skills" },
			},
		]);
	});

	it("starts, waits for and deletes a Sandbox", async () => {
		const fake = fakeOrrery(() =>
			Response.json({ ...sandbox, state: "ready" }, { status: 202 }),
		);
		const client = orrery({ url: "http://o", token: "t", fetch: fake.fetch });
		await client.startSandbox("sb 1");
		expect(await client.getSandbox("sb1", { waitFor: "ready" })).toMatchObject({
			state: "ready",
		});
		await client.deleteSandbox("sb1");
		expect(fake.sent.map((s) => `${s.method} ${s.url}`)).toEqual([
			"POST http://o/api/v1/sandboxes/sb%201/start",
			"GET http://o/api/v1/sandboxes/sb1?wait_for=ready",
			"DELETE http://o/api/v1/sandboxes/sb1",
		]);
	});

	it("runs an Exec and reads its output page by page", async () => {
		const frames = [
			{ seq: 0, stream: "stdout", data: "héllo\n" },
			{ seq: 12, stream: "stderr", data: "/w==", encoding: "base64" },
		];
		const fake = fakeOrrery((s) =>
			s.url.includes("/output")
				? Response.json(frames)
				: Response.json(
						{
							id: "ex1",
							state: "finished",
							result: { cause: "exited", exit_code: 0 },
						},
						{ status: s.method === "POST" ? 201 : 200 },
					),
		);
		const client = orrery({ url: "http://o", token: "t", fetch: fake.fetch });
		const exec = await client.createExec("sb1", {
			argv: ["python3", "-c", "print(1)"],
			cwd: ".skills/pdf",
		});
		expect(exec.id).toBe("ex1");
		expect(fake.sent[0].body).toEqual({
			argv: ["python3", "-c", "print(1)"],
			cwd: ".skills/pdf",
		});
		expect((await client.getExec("ex1")).result).toEqual({
			cause: "exited",
			exit_code: 0,
		});
		const page = await client.execOutput("ex1", 0);
		expect(page.map((f) => f.data)).toEqual(["héllo\n", "/w=="]);
		// the next `after`: seq + 5-byte header + decoded length ("héllo\n" is 7 bytes, /w== decodes to 1)
		expect(page.map(frameEnd)).toEqual([12, 18]);
		await client.execOutput("ex1", 18);
		expect(fake.sent.at(-1)?.url).toBe(
			"http://o/api/v1/execs/ex1/output?after=18",
		);
	});

	it("writes and reads Workspace files, and uploads a tar", async () => {
		const fake = fakeOrrery((s) =>
			s.method === "GET"
				? new Response("contents")
				: new Response(null, { status: 204 }),
		);
		const client = orrery({ url: "http://o", token: "t", fetch: fake.fetch });
		await client.writeFile(
			"sb1",
			"uploads/a b.txt",
			new TextEncoder().encode("hi"),
		);
		await client.uploadArchive(
			"sb1",
			".skills/pdf",
			new TextEncoder().encode("tar"),
		);
		const read = await client.readFile("sb1", "out/report.pdf");
		expect(new TextDecoder().decode(read)).toBe("contents");
		expect(fake.sent.map((s) => [s.method, s.url, s.body])).toEqual([
			[
				"PUT",
				"http://o/api/v1/sandboxes/sb1/files/content?path=uploads%2Fa+b.txt",
				"hi",
			],
			[
				"PUT",
				"http://o/api/v1/sandboxes/sb1/files/archive?path=.skills%2Fpdf",
				"tar",
			],
			[
				"GET",
				"http://o/api/v1/sandboxes/sb1/files/content?path=out%2Freport.pdf",
				undefined,
			],
		]);
	});

	it("streams a file as it arrives, the timeout bounding only the wait for its start", async () => {
		const fake = fakeOrrery((s) =>
			s.url.endsWith("path=slow")
				? new Response(
						new ReadableStream({
							async pull(controller) {
								await new Promise((r) => setTimeout(r, 60));
								controller.enqueue(new TextEncoder().encode("late"));
								controller.close();
							},
						}),
						{ headers: { "content-length": "4" } },
					)
				: new Promise(() => {}),
		);
		const client = orrery({
			url: "http://o",
			token: "t",
			fetch: async (i, init) => {
				const pending = fake.fetch(i, init);
				// a reply that never starts gives up as fetch does when its signal aborts
				return Promise.race([
					pending,
					new Promise<never>((_, reject) =>
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						),
					),
				]);
			},
			timeoutMs: 30,
		});
		const file = await client.openFile("sb1", "slow");
		expect(file.size).toBe(4);
		expect(await new Response(file.body).text()).toBe("late");
		await expect(client.openFile("sb1", "never")).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});

	it("surfaces orrery's error code, status and detail", async () => {
		const fake = fakeOrrery(() =>
			problem(409, "conflict", "sandbox is not ready"),
		);
		const client = orrery({ url: "http://o", token: "t", fetch: fake.fetch });
		const error = await client
			.createExec("sb1", { argv: ["ls"] })
			.catch((e) => e);
		expect(error).toBeInstanceOf(OrreryError);
		expect(error).toMatchObject({
			status: 409,
			code: "conflict",
			detail: "sandbox is not ready",
		});
	});

	it("reports a non-problem error body by its status", async () => {
		const fake = fakeOrrery(() => new Response("bad gateway", { status: 502 }));
		const client = orrery({ url: "http://o", token: "t", fetch: fake.fetch });
		await expect(client.getSandbox("sb1")).rejects.toMatchObject({
			status: 502,
			code: "",
		});
	});

	it("gives up on a request that takes longer than its timeout", async () => {
		const hanging = (_i: string | URL, init?: RequestInit) =>
			new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				),
			);
		const client = orrery({
			url: "http://o",
			token: "t",
			fetch: hanging,
			timeoutMs: 30,
		});
		await expect(client.getSandbox("sb1")).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});
});

describe("Sandbox Provider connection test", () => {
	const provider = { url: "http://o", token: "orr_1_s" };

	it("succeeds when orrery accepts the API Token", async () => {
		const fake = fakeOrrery(() =>
			Response.json({ id: "u1", name: "orqestra" }),
		);
		expect(await testSandboxProvider(provider, { fetch: fake.fetch })).toEqual({
			ok: true,
		});
		expect(fake.sent[0]).toMatchObject({
			url: "http://o/api/v1/users/me",
			auth: "Bearer orr_1_s",
		});
	});

	it("reports a rejected API Token", async () => {
		const fake = fakeOrrery(() =>
			problem(401, "unauthenticated", "token is revoked"),
		);
		expect(await testSandboxProvider(provider, { fetch: fake.fetch })).toEqual({
			ok: false,
			reason: "auth",
			detail: "token is revoked",
		});
	});

	it("reports an orrery it cannot reach", async () => {
		const result = await testSandboxProvider(provider, {
			fetch: () =>
				Promise.reject(
					new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }),
				),
		});
		expect(result).toEqual({
			ok: false,
			reason: "unreachable",
			detail: "fetch failed: ECONNREFUSED",
		});
	});

	it("gives up on an orrery that does not answer in time", async () => {
		const result = await testSandboxProvider(provider, {
			fetch: (_i, init) =>
				new Promise((_, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
			timeoutMs: 30,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
	});

	it("reports other failures with their detail", async () => {
		const fake = fakeOrrery(() => new Response("oops", { status: 500 }));
		const result = await testSandboxProvider(provider, { fetch: fake.fetch });
		expect(result).toMatchObject({ ok: false, reason: "failed" });
		expect(result.ok || result.detail).toContain("500");
	});
});
