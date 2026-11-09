import { SKILL_ZIP_MAX_BYTES } from "@orqestra/config/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ admin: true as boolean | undefined }));
const upload = vi.hoisted(() => vi.fn());
vi.mock("#/lib/session", () => ({
	readUser: async () =>
		user.admin === undefined ? null : { id: "u", admin: user.admin },
}));
vi.mock("@orqestra/config/live", () => ({ config: { skills: { upload } } }));

const { Route } = await import("#/routes/api/skills");
// the handler's context is TanStack's; it reads only the request
const post = (
	Route.options.server as unknown as {
		handlers: { POST: (ctx: { request: Request }) => Promise<Response> };
	}
).handlers.POST;
const send = (request: Request) => post({ request });

/** A body that records whether it was read. */
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
const request = (
	stream: ReadableStream<Uint8Array>,
	headers = {},
	query = "",
) =>
	new Request(`http://x/api/skills${query}`, {
		method: "POST",
		body: stream,
		headers,
		// @ts-expect-error: Node needs it for a stream body
		duplex: "half",
	});

describe("uploading a Skill", () => {
	beforeEach(() => {
		user.admin = true;
		upload.mockReset();
		upload.mockResolvedValue({ errors: {}, name: "pdf" });
	});

	it("passes the zip and replace to the Skills", async () => {
		const { stream } = body(new Uint8Array([1, 2, 3]));
		const response = await send(request(stream, {}, "?replace=true"));
		expect(await response.json()).toEqual({ errors: {}, name: "pdf" });
		expect(upload).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), true);
	});

	it("refuses anyone but an Admin without reading the body", async () => {
		for (const [admin, status] of [
			[undefined, 401],
			[false, 403],
		] as const) {
			user.admin = admin;
			const { stream, state } = body(new Uint8Array([1]));
			expect((await send(request(stream))).status).toBe(status);
			expect(state.read).toBe(false);
		}
		expect(upload).not.toHaveBeenCalled();
	});

	it("refuses a zip over the limit, by its declared length or as it comes", async () => {
		const declared = body(new Uint8Array([1]));
		const refused = await send(
			request(declared.stream, {
				"content-length": String(SKILL_ZIP_MAX_BYTES + 1),
			}),
		);
		expect(refused.status).toBe(413);
		expect(declared.state.read).toBe(false);
		const counted = await send(
			request(body(new Uint8Array(SKILL_ZIP_MAX_BYTES + 1)).stream),
		);
		expect(counted.status).toBe(413);
		expect(await counted.json()).toEqual({
			errors: { file: { code: "skill_too_large" } },
		});
		expect(upload).not.toHaveBeenCalled();
	});
});
