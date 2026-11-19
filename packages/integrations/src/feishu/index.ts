// Feishu as an Integration: a self-built app's bot, installed by its app id and secret, which people write to one-to-one or @-mention
// in a group; events come down Feishu's long connection, so Orqestra needs no public address. https://open.feishu.cn/document/
// The app needs the bot capability and the scopes im:message.p2p_msg:readonly, im:message.group_at_msg:readonly and
// im:message:send_as_bot; contact:user.base:readonly only to name the people who write (else they go by their open_id).
// shortcut: open.feishu.cn only; Lark (open.larksuite.com) is the same API on another host, make the host a field if one asks for it.

import { createHash } from "node:crypto";
import {
	EventDispatcher,
	LoggerLevel,
	WSClient,
} from "@larksuiteoapi/node-sdk";
import { z } from "zod";
import type {
	Activity,
	Auth,
	Fetch,
	SessionEvent,
	WorkSource,
} from "../ports.ts";

const API = "https://open.feishu.cn/open-apis";

/**
 * The most a post message's request body may be: Feishu takes 30 KB for a post or card, its own fields (receive id, msg_type) a
 * hundred bytes or so of it.
 */
const MAX_BYTES = 29_000;
const TRUNCATED =
	"\n\n[Cut short: longer than Feishu shows. The whole of it is in the Conversation in Orqestra.]";

/** What a person sends the bot in a one-to-one chat to leave its session and start another. */
const RESET = "/new";

const ids = z.object({ open_id: z.string() });
// only the fields Orqestra reads; the WSClient hands a handler the event's header and body merged into one object
const messageEvent = z.object({
	sender: z.object({ sender_id: ids.nullish(), sender_type: z.string() }),
	message: z.object({
		message_id: z.string(),
		root_id: z.string().nullish(),
		chat_id: z.string(),
		chat_type: z.string(),
		message_type: z.string(),
		content: z.string(),
		mentions: z
			.array(z.object({ key: z.string(), id: ids.partial(), name: z.string() }))
			.nullish(),
	}),
});

const postElement = z.object({
	tag: z.string(),
	text: z.string().optional(),
	user_id: z.string().optional(),
	language: z.string().optional(),
});
const messageContent = z.object({
	text: z.string().optional(),
	// a post's: rows of elements
	title: z.string().optional(),
	content: z.array(z.array(postElement)).optional(),
});

/** One request to Feishu's open API, with the tenant token when given: the answer's body; throws unless it answered code 0. */
async function feishuApi(
	path: string,
	{
		token,
		method = "POST",
		body,
		fetch = globalThis.fetch,
	}: { token?: string; method?: string; body?: unknown; fetch?: Fetch },
): Promise<Record<string, unknown>> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			...(token && { authorization: `Bearer ${token}` }),
			"content-type": "application/json; charset=utf-8",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const answer = (await response.json().catch(() => ({}))) as {
		code?: number;
		msg?: string;
	};
	if (!response.ok || answer.code !== 0)
		throw new Error(
			`Feishu's ${path.split("?")[0]} answered ${response.status}: ${answer.code ?? ""} ${answer.msg ?? ""}`,
		);
	return answer;
}

/** The app's bot: its name and its open_id, which a group message names it by when it is @-mentioned. */
async function botInfo(token: string, fetch?: Fetch) {
	return z
		.object({ bot: z.object({ app_name: z.string(), open_id: z.string() }) })
		.parse(await feishuApi("/bot/v3/info", { token, method: "GET", fetch }))
		.bot;
}

/** A message's text with its mentions written out, the bot's own removed; a post's rows as lines, its code blocks fenced. */
function messageText(
	type: string,
	raw: string,
	mentions: z.infer<typeof messageEvent>["message"]["mentions"],
	botOpenId: string,
): string | undefined {
	let content: z.infer<typeof messageContent>;
	try {
		content = messageContent.parse(JSON.parse(raw));
	} catch {
		return undefined;
	}
	const text =
		type === "text"
			? content.text
			: type === "post"
				? [
						content.title,
						...(content.content ?? []).map((row) =>
							row
								.map((e) =>
									e.tag === "at"
										? (e.user_id ?? "")
										: e.tag === "code_block"
											? `\n\`\`\`${e.language?.toLowerCase() ?? ""}\n${e.text ?? ""}\n\`\`\`\n`
											: (e.text ?? ""),
								)
								.join(""),
						),
					]
						.filter(Boolean)
						.join("\n")
				: undefined;
	if (text === undefined) return undefined;
	// a mention is a placeholder such as `@_user_1`, named by the message's `mentions`; the longest first, so `@_user_1` is not
	// replaced inside `@_user_10`
	return [...(mentions ?? [])]
		.sort((a, b) => b.key.length - a.key.length)
		.reduce(
			(t, m) =>
				m.id.open_id === botOpenId
					? t.replaceAll(`${m.key} `, "").replaceAll(m.key, "")
					: t.replaceAll(m.key, `@${m.name}`),
			text,
		)
		.trim();
}

/**
 * An `im.message.receive_v1` event as a session's event, `botOpenId` the app's bot: null for one Orqestra does not act on (a bot's,
 * a group message not @-mentioning the bot, an image). A one-to-one chat is one rolling session, `/new` resetting it; a group's
 * session is a thread, under the message that started it. `from.name` is the sender's open_id: the event does not name them.
 */
export function messageSessionEvent(
	payload: unknown,
	botOpenId: string,
): SessionEvent | null {
	const parsed = messageEvent.safeParse(payload);
	if (!parsed.success) return null;
	const { sender, message } = parsed.data;
	// a bot's message, the app's own included, never starts a session
	if (sender.sender_type !== "user" || !sender.sender_id) return null;
	const group = message.chat_type === "group";
	// the scopes above push only messages @-mentioning the bot, but an app also granted every group message gets the rest
	if (group && !message.mentions?.some((m) => m.id.open_id === botOpenId))
		return null;
	const text = messageText(
		message.message_type,
		message.content,
		message.mentions,
		botOpenId,
	);
	if (text === undefined) return null;
	const from = {
		id: sender.sender_id.open_id,
		name: sender.sender_id.open_id,
	};
	const event = {
		id: message.message_id,
		from,
		issue: null,
		scope: message.chat_id,
		shared: group,
		stop: false,
	};
	if (group)
		return {
			...event,
			sessionId: `thread:${message.root_id || message.message_id}`,
			action: message.root_id ? "prompted" : "created",
			text,
		};
	// a one-to-one chat has no start: its first message opens the session, every one after goes on with it
	return text === RESET
		? {
				...event,
				sessionId: `chat:${message.chat_id}`,
				action: "reset",
				text: null,
			}
		: {
				...event,
				sessionId: `chat:${message.chat_id}`,
				action: "prompted",
				text,
			};
}

/** The event with its sender's name, when the app may read it (contact:user.base:readonly); as it was otherwise. */
export async function named(
	event: SessionEvent,
	token: string,
	fetch?: Fetch,
): Promise<SessionEvent> {
	if (!event.from) return event;
	try {
		const { data } = z
			.object({ data: z.object({ user: z.object({ name: z.string() }) }) })
			.parse(
				await feishuApi(
					`/contact/v3/users/${encodeURIComponent(event.from.id)}?user_id_type=open_id`,
					{ token, method: "GET", fetch },
				),
			);
		return { ...event, from: { ...event.from, name: data.user.name } };
	} catch {
		return event;
	}
}

/** A post message's content showing `body` as Markdown, cut so the request carrying it stays within what Feishu takes. */
function postContent(body: string): string {
	let text = body;
	for (;;) {
		const content = JSON.stringify({
			zh_cn: { content: [[{ tag: "md", text }]] },
		});
		// the request's body holds the content as a JSON string again, so escapes count twice
		const size = Buffer.byteLength(JSON.stringify(content));
		if (size <= MAX_BYTES) return content;
		const keep = Math.floor((text.length * MAX_BYTES) / size);
		// leaving no half of a surrogate pair at the cut
		text =
			body
				.slice(0, Math.max(0, keep - TRUNCATED.length))
				.replace(/[\uD800-\uDBFF]$/, "") + TRUNCATED;
	}
}

/**
 * A post message's request fields showing `body`, its `uuid` derived from `key` and the body: Feishu sends one message per uuid an
 * hour, so a post retried after a lost answer is not shown twice.
 * shortcut: the same body posted again under the same key within the hour is taken for a retry and not shown; derive the uuid from
 * an Activity id instead, should the port give one.
 */
function postMessage(key: string, body: string) {
	return {
		msg_type: "post",
		content: postContent(body),
		// Feishu takes a uuid of up to 50 characters
		uuid: createHash("sha256")
			.update(`${key}\0${body}`)
			.digest("hex")
			.slice(0, 32),
	};
}

/** Sends `body` as the bot to a chat or a person, by `receiveIdType`, `key` naming what it answers (see postMessage). */
function send(
	{ token }: Auth,
	receiveIdType: "chat_id" | "open_id",
	receiveId: string,
	key: string,
	body: string,
	fetch: Fetch,
) {
	return feishuApi(`/im/v1/messages?receive_id_type=${receiveIdType}`, {
		token,
		body: { receive_id: receiveId, ...postMessage(key, body) },
		fetch,
	});
}

export const feishu: WorkSource = {
	kind: "feishu",
	name: "Feishu",
	install: {
		mode: "credentials",
		fields: [
			{ name: "appId", secret: false },
			{ name: "appSecret", secret: true },
		],

		// Feishu answers the token it issued while over 30 minutes of it remain, a new one after
		async token(credentials, fetch) {
			const { tenant_access_token, expire } = z
				.object({ tenant_access_token: z.string(), expire: z.number() })
				.parse(
					await feishuApi("/auth/v3/tenant_access_token/internal", {
						body: {
							app_id: credentials.appId,
							app_secret: credentials.appSecret,
						},
						fetch,
					}),
				);
			// a minute short, so no request starts with a token about to lapse
			return {
				accessToken: tenant_access_token,
				expiresAt: Date.now() + (expire - 60) * 1000,
			};
		},

		// the bot's name: answered only for a token the app's credentials got, with its bot enabled
		async workspace({ token }, fetch) {
			return (await botInfo(token, fetch)).app_name;
		},
	},

	ingress: {
		mode: "stream",
		async connect(auth, onEvent, signal) {
			if (signal.aborted) return;
			// refused credentials throw here: the WSClient retries an unknown app's as if Feishu were busy, and only logs a malformed id
			const { token, credentials } = await auth();
			const bot = await botInfo(token);
			// the WSClient runs handlers as frames arrive; the port takes one event at a time
			let last = Promise.resolve();
			const receive = async (payload: unknown) => {
				const event = messageSessionEvent(payload, bot.open_id);
				if (event) await onEvent(await named(event, (await auth()).token));
			};
			const dispatcher = new EventDispatcher({
				loggerLevel: LoggerLevel.warn,
			}).register({
				// a handler's rejection makes the WSClient answer 500, and Feishu delivers the event again
				"im.message.receive_v1": (payload: unknown) => {
					const done = last.then(() => receive(payload));
					last = done.catch(() => {});
					return done;
				},
			});
			await new Promise<void>((resolve, reject) => {
				// called once the WSClient's own reconnecting gives up
				const client = new WSClient({
					appId: credentials.appId ?? "",
					appSecret: credentials.appSecret ?? "",
					loggerLevel: LoggerLevel.warn,
					onError(error) {
						client.close({ force: true });
						reject(error);
					},
				});
				signal.addEventListener(
					"abort",
					() => {
						client.close({ force: true });
						resolve();
					},
					{ once: true },
				);
				client.start({ eventDispatcher: dispatcher }).catch(reject);
			});
		},
	},

	// a one-to-one chat with the bot is read by the person alone
	proof: {
		mode: "private-link",
		async tell(auth, person, body, fetch) {
			await send(auth, "open_id", person.id, `proof:${person.id}`, body, fetch);
		},
	},
	sharedScopes: "listed",

	// shortcut: a thought shows nothing; a reaction on the message that prompted it would, once a post knows that message's id
	async post(auth, sessionId, { type, body }: Activity, fetch) {
		if (type === "thought") return;
		const key = `${sessionId}:${type}`;
		if (sessionId.startsWith("chat:")) {
			await send(
				auth,
				"chat_id",
				sessionId.slice("chat:".length),
				key,
				body,
				fetch,
			);
			return;
		}
		// a group session's every answer quotes the message that opened it, a follow-up's too: the session is all post knows. Not
		// reply_in_thread, which Feishu folds out of the chat's view into a topic (OpenClaw's bot.ts, LangBot and AstrBot keep it off)
		const root = sessionId.slice("thread:".length);
		await feishuApi(`/im/v1/messages/${encodeURIComponent(root)}/reply`, {
			token: auth.token,
			body: postMessage(key, body),
			fetch,
		});
	},

	// who wrote, where, the repository the chat is mapped to, and what they wrote
	firstMessage: (event: SessionEvent, repo) =>
		[
			`${event.from?.name ?? "Someone"} wrote to the bot in Feishu, ${event.shared ? `in the group chat ${event.scope}` : "one-to-one"}:`,
			repo && `Repository: ${repo}`,
			event.text,
		]
			.filter(Boolean)
			.join("\n\n"),
};
