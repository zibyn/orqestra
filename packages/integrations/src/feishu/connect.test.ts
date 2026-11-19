import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CredentialsInstall,
	SessionEvent,
	StreamIngress,
} from "../ports.ts";
import { feishu } from "./index.ts";
import { fakeFeishu, messageEvent } from "./testing.ts";

// the long connection itself, played: what connect registers for im.message.receive_v1, and what it does to the WSClient
const ws = vi.hoisted(() => ({
	receive: undefined as ((payload: unknown) => Promise<unknown>) | undefined,
	onError: undefined as ((error: Error) => void) | undefined,
	appId: "",
	closed: 0,
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { warn: 2 },
	EventDispatcher: class {
		register(handles: Record<string, (payload: unknown) => Promise<unknown>>) {
			ws.receive = handles["im.message.receive_v1"];
			return this;
		}
	},
	WSClient: class {
		constructor(o: { appId: string; onError: (error: Error) => void }) {
			ws.appId = o.appId;
			ws.onError = o.onError;
		}
		async start() {}
		close() {
			ws.closed++;
		}
	},
}));

const { connect } = feishu.ingress as StreamIngress;

/** Connected to a fake Feishu, whose open API `fetch` may stand in front of. */
async function connected(
	onEvent: (event: SessionEvent) => Promise<void>,
	fetch?: (
		input: string | URL,
		init: RequestInit | undefined,
		feishu: ReturnType<typeof fakeFeishu>["fetch"],
	) => Promise<Response>,
) {
	const fake = fakeFeishu();
	vi.stubGlobal(
		"fetch",
		fetch
			? (input: string | URL, init?: RequestInit) =>
					fetch(input, init, fake.fetch)
			: fake.fetch,
	);
	const credentials = { appId: fake.appId, appSecret: fake.appSecret };
	const install = feishu.install as Required<CredentialsInstall>;
	const auth = async () => ({
		token: (await install.token(credentials, fake.fetch)).accessToken,
		credentials,
	});
	const abort = new AbortController();
	ws.receive = undefined;
	const done = connect(auth, onEvent, abort.signal, {
		load: async () => null,
		save: async () => {},
	});
	const receive = await vi.waitFor(() => {
		if (!ws.receive) throw new Error("not connected yet");
		return ws.receive;
	});
	return { abort, done, receive, fake };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("feishu connect", () => {
	it("hands on one named event at a time, and resolves once aborted", async () => {
		const seen: string[] = [];
		let release = () => {};
		const { abort, done, receive } = await connected(async (event) => {
			seen.push(`${event.text} from ${event.from?.name}`);
			if (event.text === "first")
				await new Promise<void>((r) => {
					release = r;
				});
		});
		expect(ws.appId).toBe("cli_app");
		const first = receive(messageEvent({ text: "first" }));
		const second = receive(messageEvent({ text: "second" }));
		const ignored = receive(messageEvent({ senderType: "app" }));
		await vi.waitFor(() => expect(seen).toEqual(["first from Uma"]));
		// time for the second to overtake, were it not held back
		await new Promise((r) => setTimeout(r, 50));
		expect(seen).toEqual(["first from Uma"]);
		release();
		await Promise.all([first, second, ignored]);
		expect(seen).toEqual(["first from Uma", "second from Uma"]);
		const closed = ws.closed;
		abort.abort();
		await done;
		expect(ws.closed).toBe(closed + 1);
	});

	it("fails an event whose handling threw, so Feishu sends it again, and goes on with the next", async () => {
		const seen: string[] = [];
		const { abort, done, receive } = await connected(async (event) => {
			if (event.text === "boom") throw new Error("queue down");
			seen.push(event.text ?? "");
		});
		await expect(receive(messageEvent({ text: "boom" }))).rejects.toThrow(
			"queue down",
		);
		await receive(messageEvent({ text: "after" }));
		expect(seen).toEqual(["after"]);
		abort.abort();
		await done;
	});

	it("reacts OnIt to each message it acts on, and to none it ignores", async () => {
		const { abort, done, receive, fake } = await connected(async () => {});
		await receive(messageEvent({ messageId: "om_1" }));
		await receive(messageEvent({ messageId: "om_bot", senderType: "app" }));
		await vi.waitFor(() =>
			expect(fake.reactions).toEqual([
				{ messageId: "om_1", emojiType: "OnIt" },
			]),
		);
		abort.abort();
		await done;
	});

	it("answers Feishu well within its 3 s while the name and the reaction hang, the sender going by their open_id", async () => {
		const seen: string[] = [];
		const { abort, done, receive } = await connected(
			async (event) => {
				seen.push(event.from?.name ?? "");
			},
			(input, init, feishu) =>
				/\/contact\/|\/reactions$/.test(String(input))
					? new Promise<Response>(() => {})
					: feishu(input, init),
		);
		const start = Date.now();
		await Promise.all([
			receive(messageEvent()),
			receive(messageEvent()),
			receive(messageEvent({ senderId: "ou_ann" })),
		]);
		expect(Date.now() - start).toBeLessThan(1000);
		expect(seen).toEqual(["ou_uma", "ou_uma", "ou_ann"]);
		abort.abort();
		await done;
	});

	it("hands on the event when Feishu refuses the reaction, and logs it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const seen: string[] = [];
		const { abort, done, receive } = await connected(
			async (event) => {
				seen.push(event.text ?? "");
			},
			(input, init, feishu) =>
				String(input).endsWith("/reactions")
					? Promise.resolve(
							Response.json(
								{ code: 231001, msg: "reaction type is invalid." },
								{ status: 400 },
							),
						)
					: feishu(input, init),
		);
		await receive(messageEvent({ text: "hi", messageId: "om_1" }));
		expect(seen).toEqual(["hi"]);
		await vi.waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"Feishu took no reaction to message om_1",
				expect.any(Error),
			),
		);
		error.mockRestore();
		abort.abort();
		await done;
	});

	it("throws once the WSClient gives up", async () => {
		const { done } = await connected(async () => {});
		ws.onError?.(new Error("reconnects exhausted"));
		await expect(done).rejects.toThrow("reconnects exhausted");
	});
});
