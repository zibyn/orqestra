import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent, StreamIngress } from "../ports.ts";
import { ConnectedElsewhere, sessionEvent, wecomSource } from "./index.ts";
import { fakeWecom, messageFrame } from "./testing.ts";

const credentials = { botId: "bot-1", secret: "bot-s3cret" };
const auth = { token: "", credentials };
// WeCom keeps nothing between connections
const noState = { load: async () => null, save: async () => {} };
const noFetch = () =>
	Promise.reject(new Error("WeCom is reached by its connection"));

/** The source connected through a fake WeCom, `events` what it took in; `stop` closes the connection and resolves `done`. */
async function connected() {
	const wecom = fakeWecom();
	const source = wecomSource(wecom.create);
	const events: SessionEvent[] = [];
	const controller = new AbortController();
	const done = (source.ingress as StreamIngress).connect(
		async () => auth,
		async (event) => {
			events.push(event);
		},
		controller.signal,
		noState,
	);
	await vi.waitFor(() => expect(wecom.holder()).toBeDefined());
	return { wecom, source, events, done, stop: () => controller.abort() };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a message WeCom pushes", () => {
	it("is a prompt in its person's rolling one-to-one session", () => {
		expect(
			sessionEvent(messageFrame({ msgid: "m1", text: "Fix the login button" })),
		).toEqual({
			id: "m1",
			sessionId: "single:zhangsan",
			action: "prompted",
			from: { id: "zhangsan", name: "zhangsan" },
			issue: null,
			scope: null,
			shared: false,
			text: "Fix the login button",
			stop: false,
		});
	});

	it("in a group is its sender's session there, shared, the bot's @-mention cut from it", () => {
		const event = sessionEvent(
			messageFrame({ chatid: "chat-1", text: "@RobotA  look at @lisi's bug" }),
		);
		expect(event).toMatchObject({
			sessionId: "group:chat-1:zhangsan",
			scope: "chat-1",
			shared: true,
			text: "look at @lisi's bug",
		});
		expect(
			sessionEvent(
				messageFrame({ chatid: "chat-1", userid: "lisi", text: "@RobotA hi" }),
			)?.sessionId,
		).toBe("group:chat-1:lisi");
	});

	it("/new resets the session", () => {
		expect(sessionEvent(messageFrame({ text: " /new " }))).toMatchObject({
			action: "reset",
			sessionId: "single:zhangsan",
			text: null,
		});
		expect(
			sessionEvent(messageFrame({ chatid: "chat-1", text: "@RobotA /new" })),
		).toMatchObject({ action: "reset", sessionId: "group:chat-1:zhangsan" });
	});

	it("reads a voice message's transcript and a mixed one's text", () => {
		expect(
			sessionEvent(
				messageFrame({
					body: { msgtype: "voice", voice: { content: "hello" } },
				}),
			)?.text,
		).toBe("hello");
		expect(
			sessionEvent(
				messageFrame({
					body: {
						msgtype: "mixed",
						mixed: {
							msg_item: [
								{ msgtype: "text", text: { content: "see" } },
								{ msgtype: "image", image: { url: "u" } },
								{ msgtype: "text", text: { content: "this" } },
							],
						},
					},
				}),
			)?.text,
		).toBe("see\nthis");
	});

	it("is ignored with no person's text in it", () => {
		const ignored = [
			messageFrame({ body: { msgtype: "image", image: { url: "u" } } }),
			messageFrame({
				body: { msgtype: "text", text: { content: "x" }, from: {} },
			}),
			messageFrame({
				body: { msgtype: "text", text: { content: "x" }, from: undefined },
			}),
			messageFrame({ chatid: "chat-1", text: "@RobotA " }),
			messageFrame({ text: "   " }),
			messageFrame({
				body: { msgtype: "text", text: { content: "x" }, chattype: "group" },
			}),
			{ body: { msgtype: "event", event: { eventtype: "enter_chat" } } },
		];
		for (const frame of ignored) expect(sessionEvent(frame)).toBeNull();
	});
});

describe("connect", () => {
	it("takes each message in, the next only once the last is taken", async () => {
		const wecom = fakeWecom();
		const source = wecomSource(wecom.create);
		const taken: string[] = [];
		let release = () => {};
		const controller = new AbortController();
		const done = (source.ingress as StreamIngress).connect(
			async () => auth,
			(event) =>
				new Promise((resolve) => {
					taken.push(event.text ?? "");
					release = () => resolve();
				}),
			controller.signal,
			noState,
		);
		await vi.waitFor(() => expect(wecom.holder()).toBeDefined());
		wecom.deliver(messageFrame({ text: "one" }));
		wecom.deliver(messageFrame({ body: { msgtype: "image" } }));
		wecom.deliver(messageFrame({ text: "two" }));
		await vi.waitFor(() => expect(taken).toEqual(["one"]));
		release();
		await vi.waitFor(() => expect(taken).toEqual(["one", "two"]));
		controller.abort();
		await done;
		expect(wecom.holder()).toBeUndefined();
	});

	it("throws when WeCom refuses the bot's secret", async () => {
		const wecom = fakeWecom({ secret: "other" });
		await expect(
			(wecomSource(wecom.create).ingress as StreamIngress).connect(
				async () => auth,
				async () => {},
				new AbortController().signal,
				noState,
			),
		).rejects.toThrow(
			/refused AI bot bot-1's id and secret: Authentication failed/,
		);
	});

	it("ends with the error of an event Orqestra could not take", async () => {
		const wecom = fakeWecom();
		const done = (wecomSource(wecom.create).ingress as StreamIngress).connect(
			async () => auth,
			async () => {
				throw new Error("queue down");
			},
			new AbortController().signal,
			noState,
		);
		await vi.waitFor(() => expect(wecom.holder()).toBeDefined());
		wecom.deliver(messageFrame());
		await expect(done).rejects.toThrow("queue down");
	});

	it("ends saying the bot is connected elsewhere once another connection takes it, never taking it back", async () => {
		const { wecom, source, done } = await connected();
		// proving the credentials is a second connection
		if (source.install.mode !== "credentials")
			throw new Error("not a credentials install");
		await source.install.workspace(auth, noFetch);
		await expect(done).rejects.toBeInstanceOf(ConnectedElsewhere);
		await expect(done).rejects.toThrow(
			"WeCom AI bot bot-1 is connected elsewhere",
		);
		expect(wecom.holder()).toBeUndefined();
		await expect(
			source.post(
				auth,
				"single:zhangsan",
				{ type: "response", body: "Done." },
				noFetch,
			),
		).rejects.toThrow(/holds no connection/);
	});

	it("posts only while WeCom has acked its subscribe, again once the SDK reconnects a dropped connection", async () => {
		const { wecom, source, stop, done } = await connected();
		const response = { type: "response" as const, body: "Done." };
		const client = wecom.drop();
		await expect(
			source.post(auth, "single:zhangsan", response, noFetch),
		).rejects.toThrow(/holds no connection/);
		client.connect();
		await vi.waitFor(() => expect(wecom.holder()).toBe(client));
		await source.post(auth, "single:zhangsan", response, noFetch);
		expect(wecom.pushed.map((p) => p.chatid)).toEqual(["zhangsan"]);
		stop();
		await done;
	});
});

describe("post", () => {
	it("streams the thought on the session's frame and finishes that reply with the answer", async () => {
		const { wecom, source, events, stop, done } = await connected();
		wecom.deliver(messageFrame({ msgid: "m1" }));
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const sessionId = events[0]?.sessionId ?? "";
		await source.post(
			auth,
			sessionId,
			{ type: "thought", body: "Working on this in Orqestra." },
			noFetch,
		);
		await source.post(
			auth,
			sessionId,
			{ type: "response", body: "Done: **fixed**." },
			noFetch,
		);
		const [opened, finished] = wecom.streamed;
		expect(opened).toMatchObject({
			reqId: "req-m1",
			content: "Working on this in Orqestra.",
			finish: false,
		});
		expect(finished).toMatchObject({
			reqId: "req-m1",
			streamId: opened?.streamId,
			content: "Done: **fixed**.",
			finish: true,
		});
		expect(wecom.pushed).toEqual([]);
		// the next answer has no open reply left to finish
		await source.post(
			auth,
			sessionId,
			{ type: "response", body: "Again." },
			noFetch,
		);
		expect(wecom.pushed).toEqual([
			{
				chatid: "zhangsan",
				body: {
					chat_type: 1,
					msgtype: "markdown",
					markdown: { content: "Again." },
				},
			},
		]);
		stop();
		await done;
	});

	it("pushes an answer the streamed reply has outlived into the chat", async () => {
		const { wecom, source, events, stop, done } = await connected();
		wecom.deliver(messageFrame({ chatid: "chat-1", text: "@RobotA go" }));
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const sessionId = events[0]?.sessionId ?? "";
		await source.post(
			auth,
			sessionId,
			{ type: "thought", body: "Working." },
			noFetch,
		);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 9 * 60_000);
		await source.post(
			auth,
			sessionId,
			{ type: "elicitation", body: "Which branch?" },
			noFetch,
		);
		expect(wecom.streamed.map((s) => s.finish)).toEqual([false]);
		expect(wecom.pushed).toEqual([
			{
				chatid: "chat-1",
				body: {
					chat_type: 2,
					msgtype: "markdown",
					markdown: { content: "Which branch?" },
				},
			},
		]);
		stop();
		await done;
	});

	it("pushes the answer when WeCom takes no more of the streamed reply", async () => {
		const { wecom, source, events, stop, done } = await connected();
		wecom.deliver(messageFrame());
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const sessionId = events[0]?.sessionId ?? "";
		await source.post(
			auth,
			sessionId,
			{ type: "thought", body: "Working." },
			noFetch,
		);
		wecom.refuse.push({ errcode: 846608, errmsg: "stream finished" });
		await source.post(
			auth,
			sessionId,
			{ type: "error", body: "It broke." },
			noFetch,
		);
		expect(wecom.pushed.map((p) => p.chatid)).toEqual(["zhangsan"]);
		wecom.refuse.push({ errcode: 45009, errmsg: "api freq out of limit" });
		await expect(
			source.post(auth, sessionId, { type: "response", body: "x" }, noFetch),
		).rejects.toThrow(
			"WeCom refused the message: api freq out of limit (code 45009)",
		);
		stop();
		await done;
	});

	it("cuts a body longer than WeCom shows, at a whole character", async () => {
		const { wecom, source, stop, done } = await connected();
		await source.post(
			auth,
			"single:zhangsan",
			{ type: "response", body: "修".repeat(10_000) },
			noFetch,
		);
		const body = wecom.pushed[0]?.body;
		const content = body?.msgtype === "markdown" ? body.markdown.content : "";
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(20_480);
		expect(content).not.toContain("�");
		expect(content).toMatch(/^修+\n\n\[Cut short: longer than WeCom shows/);
		stop();
		await done;
	});

	it("works only in a process holding the bot's connection; a thought elsewhere shows nothing", async () => {
		const source = wecomSource(fakeWecom().create);
		await source.post(
			auth,
			"single:zhangsan",
			{ type: "thought", body: "Working." },
			noFetch,
		);
		await expect(
			source.post(
				auth,
				"single:zhangsan",
				{ type: "response", body: "Done." },
				noFetch,
			),
		).rejects.toThrow(/holds no connection to WeCom AI bot bot-1/);
		const { source: closed, stop, done } = await connected();
		stop();
		await done;
		await expect(
			closed.post(
				auth,
				"single:zhangsan",
				{ type: "response", body: "Done." },
				noFetch,
			),
		).rejects.toThrow(/holds no connection/);
	});
});

describe("proof and install", () => {
	it("tells a person alone, in their one-to-one chat", async () => {
		const { wecom, source, stop, done } = await connected();
		if (source.proof.mode !== "private-link")
			throw new Error("not a private link");
		await source.proof.tell(
			auth,
			{ id: "lisi", name: "lisi" },
			"Open https://orqestra.example/link",
			noFetch,
		);
		expect(wecom.pushed).toEqual([
			{
				chatid: "lisi",
				body: {
					chat_type: 1,
					msgtype: "markdown",
					markdown: { content: "Open https://orqestra.example/link" },
				},
			},
		]);
		stop();
		await done;
	});

	it("proves the credentials by subscribing, then closes", async () => {
		const wecom = fakeWecom();
		const { install } = wecomSource(wecom.create);
		if (install.mode !== "credentials")
			throw new Error("not a credentials install");
		expect(install.fields).toEqual([
			{ name: "botId", secret: false },
			{ name: "secret", secret: true },
		]);
		await expect(install.workspace(auth, noFetch)).resolves.toBe(
			"WeCom AI bot bot-1",
		);
		expect(wecom.holder()).toBeUndefined();
		await expect(
			install.workspace(
				{ token: "", credentials: { ...credentials, secret: "wrong" } },
				noFetch,
			),
		).rejects.toThrow(/refused AI bot bot-1's id and secret/);
	});
});

it("the first message says who wrote, where, the repository and the text", () => {
	const source = wecomSource(fakeWecom().create);
	const group = sessionEvent(
		messageFrame({ chatid: "chat-1", text: "@RobotA fix it" }),
	);
	const single = sessionEvent(messageFrame({ text: "fix it" }));
	if (!group || !single) throw new Error("no events");
	expect(source.firstMessage(group, "acme/web")).toBe(
		"WeCom message from zhangsan in group chat chat-1\n\nRepository: acme/web\n\nfix it",
	);
	expect(source.firstMessage(single, undefined)).toBe(
		"WeCom message from zhangsan\n\nfix it",
	);
});
