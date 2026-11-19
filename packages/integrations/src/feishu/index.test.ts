import { describe, expect, it } from "vitest";
import type {
	Activity,
	CredentialsInstall,
	PrivateLinkProof,
} from "../ports.ts";
import { feishu, messageSessionEvent, named } from "./index.ts";
import { fakeFeishu, messageEvent } from "./testing.ts";

const install = feishu.install as Required<CredentialsInstall>;
const bot = { openId: "ou_bot", name: "Orqestra" };

/** The event's session event, which the test expects Orqestra to act on. */
function acted(payload: unknown) {
	const event = messageSessionEvent(payload, bot.openId);
	if (!event) throw new Error("Orqestra does not act on this event");
	return event;
}

async function signedIn(fake: ReturnType<typeof fakeFeishu>) {
	const credentials = { appId: fake.appId, appSecret: fake.appSecret };
	const { accessToken } = await install.token(credentials, fake.fetch);
	return { token: accessToken, credentials };
}

describe("feishu install", () => {
	it("trades the app id and secret for a tenant token, and names the workspace by its bot", async () => {
		const fake = fakeFeishu();
		const before = Date.now();
		const { accessToken, expiresAt } = await install.token(
			{ appId: "cli_app", appSecret: "app-s3cret" },
			fake.fetch,
		);
		expect(fake.tenantTokens.has(accessToken)).toBe(true);
		expect(expiresAt).toBeGreaterThan(before + 7000 * 1000);
		expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7200 * 1000);
		expect(
			await install.workspace(
				{ token: accessToken, credentials: {} },
				fake.fetch,
			),
		).toBe("Orqestra");
	});

	it("throws for a wrong secret, and for a token Feishu did not issue", async () => {
		const fake = fakeFeishu();
		await expect(
			install.token({ appId: "cli_app", appSecret: "wrong" }, fake.fetch),
		).rejects.toThrow(/10014/);
		await expect(
			install.workspace({ token: "forged", credentials: {} }, fake.fetch),
		).rejects.toThrow(/400/);
	});
});

describe("feishu events", () => {
	it("makes a one-to-one chat one rolling session, prompted by each message, and /new resets it", () => {
		const first = messageSessionEvent(
			messageEvent({ text: "fix the build", messageId: "om_1" }),
			bot.openId,
		);
		expect(first).toEqual({
			id: "om_1",
			sessionId: "chat:oc_chat",
			action: "prompted",
			from: { id: "ou_uma", name: "ou_uma" },
			issue: null,
			scope: "oc_chat",
			shared: false,
			text: "fix the build",
			stop: false,
		});
		const reset = messageSessionEvent(
			messageEvent({ text: " /new " }),
			bot.openId,
		);
		expect(reset).toMatchObject({
			sessionId: "chat:oc_chat",
			action: "reset",
			text: null,
		});
	});

	it("opens a group session per thread when the bot is mentioned, the mention stripped and others named", () => {
		const mentions = [
			{ openId: bot.openId, name: bot.name },
			{ openId: "ou_ann", name: "Ann" },
		];
		const created = messageSessionEvent(
			messageEvent({
				chatType: "group",
				chatId: "oc_group",
				messageId: "om_root",
				text: "@_user_1 ask @_user_2 about this",
				mentions,
			}),
			bot.openId,
		);
		expect(created).toMatchObject({
			id: "om_root",
			sessionId: "thread:om_root",
			action: "created",
			scope: "oc_group",
			shared: true,
			text: "ask @Ann about this",
		});
		const prompted = messageSessionEvent(
			messageEvent({
				chatType: "group",
				chatId: "oc_group",
				rootId: "om_root",
				text: "@_user_1 and now?",
				mentions,
			}),
			bot.openId,
		);
		expect(prompted).toMatchObject({
			sessionId: "thread:om_root",
			action: "prompted",
			text: "and now?",
		});
	});

	it("ignores a bot's message, a group message not mentioning the bot, and what has no text", () => {
		expect(
			messageSessionEvent(messageEvent({ senderType: "bot" }), bot.openId),
		).toBeNull();
		expect(
			messageSessionEvent(
				messageEvent({
					chatType: "group",
					text: "@_user_1 hi",
					mentions: [{ openId: "ou_ann", name: "Ann" }],
				}),
				bot.openId,
			),
		).toBeNull();
		expect(
			messageSessionEvent(
				messageEvent({
					messageType: "image",
					content: JSON.stringify({ image_key: "img_1" }),
				}),
				bot.openId,
			),
		).toBeNull();
		expect(messageSessionEvent({ nonsense: true }, bot.openId)).toBeNull();
	});

	it("reads a post message's rows, mentions and code blocks", () => {
		const event = messageSessionEvent(
			messageEvent({
				chatType: "group",
				messageType: "post",
				mentions: [{ openId: bot.openId, name: bot.name }],
				content: JSON.stringify({
					title: "Bug",
					content: [
						[
							{ tag: "at", user_id: "@_user_1", user_name: "" },
							{ tag: "text", text: " this fails:" },
						],
						[{ tag: "code_block", language: "GO", text: "panic()" }],
					],
				}),
			}),
			bot.openId,
		);
		expect(event?.text).toBe("Bug\nthis fails:\n\n```go\npanic()\n```");
	});

	it("names the sender when the app may read them, and keeps their open_id otherwise", async () => {
		const fake = fakeFeishu();
		const { token } = await signedIn(fake);
		const uma = acted(messageEvent());
		expect((await named(uma, token, fake.fetch)).from).toEqual({
			id: "ou_uma",
			name: "Uma",
		});
		const stranger = acted(messageEvent({ senderId: "ou_who" }));
		expect((await named(stranger, token, fake.fetch)).from).toEqual({
			id: "ou_who",
			name: "ou_who",
		});
	});
});

describe("feishu post", () => {
	const markdown = (content: string) =>
		JSON.parse(content).zh_cn.content[0][0] as { tag: string; text: string };

	it("sends to a one-to-one chat, replies to a group session's first message in the chat (not a topic), and shows no thought", async () => {
		const fake = fakeFeishu();
		const auth = await signedIn(fake);
		await feishu.post(
			auth,
			"chat:oc_chat",
			{ type: "response", body: "**done**" },
			fake.fetch,
		);
		await feishu.post(
			auth,
			"thread:om_root",
			{ type: "elicitation", body: "Which branch?" },
			fake.fetch,
		);
		await feishu.post(
			auth,
			"chat:oc_chat",
			{ type: "thought", body: "Working on this in Orqestra." },
			fake.fetch,
		);
		expect(
			fake.messages.map(({ content, ...m }) => ({
				...m,
				md: markdown(content),
			})),
		).toEqual([
			{
				receiveIdType: "chat_id",
				receiveId: "oc_chat",
				msgType: "post",
				md: { tag: "md", text: "**done**" },
			},
			{
				replyTo: "om_root",
				replyInThread: undefined,
				msgType: "post",
				md: { tag: "md", text: "Which branch?" },
			},
		]);
	});

	it("shows a retried post once, and each other post anew", async () => {
		const fake = fakeFeishu();
		const auth = await signedIn(fake);
		const posts: [string, Activity][] = [
			["thread:om_root", { type: "response", body: "done" }],
			["thread:om_root", { type: "response", body: "done" }],
			["thread:om_root", { type: "error", body: "done" }],
			["thread:om_other", { type: "response", body: "done" }],
			["chat:oc_chat", { type: "response", body: "done" }],
			["chat:oc_chat", { type: "response", body: "done" }],
			["chat:oc_chat", { type: "response", body: "done, again" }],
		];
		for (const [sessionId, activity] of posts)
			await feishu.post(auth, sessionId, activity, fake.fetch);
		expect(fake.messages.map((m) => m.replyTo ?? m.receiveId)).toEqual([
			"om_root",
			"om_root",
			"om_other",
			"oc_chat",
			"oc_chat",
		]);
	});

	it("cuts a body too long for Feishu, saying the rest is in Orqestra", async () => {
		const fake = fakeFeishu();
		const auth = await signedIn(fake);
		// quotes and newlines are escaped twice on the way, so they weigh most
		const body = '"line"\n'.repeat(20_000);
		await feishu.post(
			auth,
			"chat:oc_chat",
			{ type: "response", body },
			fake.fetch,
		);
		const [sent] = fake.messages;
		const request = JSON.stringify({
			receive_id: "oc_chat",
			msg_type: "post",
			content: sent?.content,
		});
		expect(Buffer.byteLength(request)).toBeLessThanOrEqual(30 * 1024);
		const { text } = markdown(sent?.content ?? "");
		expect(text).toMatch(/whole of it is in the Conversation in Orqestra\.\]$/);
		expect(body.startsWith(text.slice(0, text.indexOf("\n\n[Cut short")))).toBe(
			true,
		);
	});

	it("proves a person by a direct message to their open_id", async () => {
		const fake = fakeFeishu();
		const auth = await signedIn(fake);
		await (feishu.proof as PrivateLinkProof).tell(
			auth,
			{ id: "ou_uma", name: "Uma" },
			"Open https://orqestra.example/link/abc while signed in.",
			fake.fetch,
		);
		expect(fake.messages).toMatchObject([
			{ receiveIdType: "open_id", receiveId: "ou_uma", msgType: "post" },
		]);
	});

	it("throws when Feishu refuses the token", async () => {
		const fake = fakeFeishu();
		await expect(
			feishu.post(
				{ token: "forged", credentials: {} },
				"chat:oc_chat",
				{ type: "response", body: "hi" },
				fake.fetch,
			),
		).rejects.toThrow(/99991663/);
	});
});

describe("feishu firstMessage", () => {
	it("says who wrote, where, the repository and the text", () => {
		const event = {
			...acted(
				messageEvent({
					chatType: "group",
					chatId: "oc_group",
					// the bot is the tenth mentioned: `@_user_1` must not be read inside `@_user_10`
					text: "@_user_10 fix it",
					mentions: [
						...Array.from({ length: 9 }, (_, i) => ({
							openId: `ou_${i}`,
							name: `P${i}`,
						})),
						{ openId: bot.openId, name: bot.name },
					],
				}),
			),
			from: { id: "ou_uma", name: "Uma" },
		};
		expect(feishu.firstMessage(event, "acme/web")).toBe(
			"Uma wrote to the bot in Feishu, in the group chat oc_group:\n\nRepository: acme/web\n\nfix it",
		);
	});
});
