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

async function connected(onEvent: (event: SessionEvent) => Promise<void>) {
	const fake = fakeFeishu();
	vi.stubGlobal("fetch", fake.fetch);
	const credentials = { appId: fake.appId, appSecret: fake.appSecret };
	const install = feishu.install as Required<CredentialsInstall>;
	const auth = async () => ({
		token: (await install.token(credentials, fake.fetch)).accessToken,
		credentials,
	});
	const abort = new AbortController();
	ws.receive = undefined;
	const done = connect(auth, onEvent, abort.signal);
	const receive = await vi.waitFor(() => {
		if (!ws.receive) throw new Error("not connected yet");
		return ws.receive;
	});
	return { abort, done, receive };
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
		const ignored = receive(messageEvent({ senderType: "bot" }));
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

	it("throws once the WSClient gives up", async () => {
		const { done } = await connected(async () => {});
		ws.onError?.(new Error("reconnects exhausted"));
		await expect(done).rejects.toThrow("reconnects exhausted");
	});
});
