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
	it("answers a thought once on its message's frame, finished at once, and pushes the closing activity into the chat", async () => {
		const { wecom, source, events, stop, done } = await connected();
		wecom.deliver(messageFrame({ msgid: "m1", chatid: "chat-1" }));
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const sessionId = events[0]?.sessionId ?? "";
		const thought = { type: "thought" as const, body: "收到，正在处理…" };
		await source.post(auth, sessionId, thought, noFetch);
		await source.post(auth, sessionId, thought, noFetch);
		await source.post(
			auth,
			sessionId,
			{ type: "response", body: "Done: **fixed**." },
			noFetch,
		);
		expect(wecom.streamed).toEqual([
			{
				reqId: "req-m1",
				streamId: expect.any(String),
				content: "收到，正在处理…",
				finish: true,
			},
		]);
		expect(wecom.pushed).toEqual([
			{
				chatid: "chat-1",
				body: {
					chat_type: 2,
					msgtype: "markdown",
					markdown: { content: "Done: **fixed**." },
				},
			},
		]);
		stop();
		await done;
	});

	it("fails nothing on a thought WeCom no longer answers the frame of; throws a push it refuses", async () => {
		const { wecom, source, events, stop, done } = await connected();
		wecom.deliver(messageFrame());
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const sessionId = events[0]?.sessionId ?? "";
		wecom.refuse.push({ errcode: 846608, errmsg: "stream expired" });
		await source.post(
			auth,
			sessionId,
			{ type: "thought", body: "Working." },
			noFetch,
		);
		expect(wecom.streamed).toEqual([]);
		wecom.refuse.push({ errcode: 45009, errmsg: "api freq out of limit" });
		await expect(
			source.post(auth, sessionId, { type: "response", body: "x" }, noFetch),
		).rejects.toThrow(
			"WeCom refused the message: api freq out of limit (code 45009)",
		);
		stop();
		await done;
	});

	it("splits Markdown longer than WeCom takes into messages two seconds apart, a code block closed and opened again at a split", async () => {
		const { wecom, source, stop, done } = await connected();
		vi.useFakeTimers();
		const line = "修".repeat(1_000);
		const body = ["Intro", "```ts", ...Array(10).fill(line), "```", "End"].join(
			"\n",
		);
		const posting = source.post(
			auth,
			"single:zhangsan",
			{ type: "response", body },
			noFetch,
		);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(wecom.pushed).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await posting;
		const sent = wecom.pushed.map((p) =>
			p.body.msgtype === "markdown" ? p.body.markdown.content : "",
		);
		expect(sent).toHaveLength(2);
		for (const content of sent)
			expect(Buffer.byteLength(content)).toBeLessThanOrEqual(20_480);
		expect(sent[0]).toMatch(/修\n```$/);
		expect(sent[1]).toMatch(/^```ts\n修/);
		expect(
			`${sent[0]?.slice(0, -"\n```".length)}\n${sent[1]?.slice("```ts\n".length)}`,
		).toBe(body);
		stop();
		await done;
	});

	it("splits a line longer than one message between characters", async () => {
		const { wecom, source, stop, done } = await connected();
		vi.useFakeTimers();
		const body = "修".repeat(10_000);
		const posting = source.post(
			auth,
			"single:zhangsan",
			{ type: "response", body },
			noFetch,
		);
		await vi.advanceTimersByTimeAsync(2_000);
		await posting;
		const sent = wecom.pushed.map((p) =>
			p.body.msgtype === "markdown" ? p.body.markdown.content : "",
		);
		expect(sent).toHaveLength(2);
		for (const content of sent)
			expect(Buffer.byteLength(content)).toBeLessThanOrEqual(20_480);
		expect(sent.join("")).toBe(body);
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
