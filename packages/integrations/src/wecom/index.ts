// WeCom (企业微信) as an Integration: its AI bot (智能机器人) installs by the bot's id and secret, holds a long connection that WeCom
// pushes each message to the bot down, and answers down the same connection. https://developer.work.weixin.qq.com/document/path/101463
// WeCom keeps one connection per bot: a new one kicks the old, so the process that holds it is the only one that can post (see `post`).
import {
	generateReqId,
	WSAuthFailureError,
	WSClient,
	type WSClientOptions,
	type WsFrame,
	type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import { z } from "zod";
import type {
	Credentials,
	SessionEvent,
	StreamIngress,
	WorkSource,
} from "../ports.ts";

/** The most WeCom takes in a markdown message or a streamed reply: 20480 bytes of UTF-8. */
const MAX_BYTES = 20_480;
const TRUNCATED =
	"\n\n[Cut short: longer than WeCom shows. The whole of it is in the Conversation in Orqestra.]";

/** WeCom ends a streamed reply by itself 10 minutes after it began; past this, the answer is pushed instead. */
const STREAM_MS = 9 * 60_000;

/** How long a connection another one kicked waits before taking the bot back (the SDK itself stops). */
const KICKED_RETRY_MS = 60_000;

/** How long proving the credentials waits for WeCom to answer the subscribe. */
const PROVE_MS = 15_000;

// only the fields Orqestra reads; the rest of the frame is ignored
const message = z.object({
	msgid: z.string(),
	chattype: z.enum(["single", "group"]),
	chatid: z.string().optional(),
	from: z.object({ userid: z.string().min(1) }),
	msgtype: z.string(),
	text: z.object({ content: z.string() }).optional(),
	// voice arrives already transcribed
	voice: z.object({ content: z.string() }).optional(),
	mixed: z
		.object({
			msg_item: z.array(
				z.object({ text: z.object({ content: z.string() }).optional() }),
			),
		})
		.optional(),
});

/**
 * A message callback's event, or null for one Orqestra does not act on: no person's text in it (an image, a file, an @-mention alone).
 * A chat has no threads, so a one-to-one chat is one rolling session per person and a group one per person in it; `/new` resets it.
 * shortcut: images, files and quoted messages are not read, only the text; download them through the SDK when people send work that way.
 */
export function sessionEvent(frame: { body?: unknown }): SessionEvent | null {
	const parsed = message.safeParse(frame.body);
	if (!parsed.success) return null;
	const m = parsed.data;
	const group = m.chattype === "group";
	if (group && !m.chatid) return null;
	const said =
		m.msgtype === "text"
			? m.text?.content
			: m.msgtype === "voice"
				? m.voice?.content
				: m.msgtype === "mixed"
					? m.mixed?.msg_item
							.flatMap((item) => (item.text ? [item.text.content] : []))
							.join("\n")
					: undefined;
	// shortcut: a group message is delivered only when it @-mentions the bot, its text starting "@<bot's name> " in WeCom's own example;
	// the bot's name is not in the frame, so the leading @-word is taken for it: a mention elsewhere in the text stays in the prompt
	const text = (group ? said?.replace(/^\s*@\S+/, "") : said)?.trim();
	if (!text) return null;
	const reset = text === "/new";
	return {
		id: m.msgid,
		sessionId: group
			? `group:${m.chatid}:${m.from.userid}`
			: `single:${m.from.userid}`,
		action: reset ? "reset" : "prompted",
		// the frame names a person by their userid alone
		from: { id: m.from.userid, name: m.from.userid },
		issue: null,
		scope: group ? (m.chatid ?? null) : null,
		shared: group,
		text: reset ? null : text,
		stop: false,
	};
}

/** Where a session's answers are pushed: a one-to-one chat by the person's userid (chat_type 1), a group by its chatid (2). */
function chatOf(sessionId: string): { chatid: string; chat_type: 1 | 2 } {
	const [kind, chatid = "", ...rest] = sessionId.split(":");
	if (kind === "single" && chatid) return { chatid, chat_type: 1 };
	if (kind === "group" && chatid && rest.length)
		return { chatid, chat_type: 2 };
	throw new Error(`Not a WeCom session: ${sessionId}`);
}

/** Cut to MAX_BYTES of UTF-8 with a note, leaving no half of a character at the cut. */
function cut(body: string): string {
	if (Buffer.byteLength(body) <= MAX_BYTES) return body;
	return (
		Buffer.from(body)
			.subarray(0, MAX_BYTES - Buffer.byteLength(TRUNCATED))
			.toString()
			.replace(/\uFFFD$/, "") + TRUNCATED
	);
}

/** Waits for WeCom's receipt; the SDK rejects a refused send with the receipt frame, not an Error. */
async function acked(sending: Promise<WsFrame>): Promise<void> {
	try {
		await sending;
	} catch (error) {
		if (error instanceof Error) throw error;
		const { errcode, errmsg } = error as WsFrame;
		throw new Error(`WeCom refused the message: ${errmsg} (code ${errcode})`);
	}
}

/** Pushes Markdown into a chat; `chat_type` is WeCom's own, which the SDK's type leaves out: a userid could equal a group's chatid. */
function push(
	client: WSClient,
	chatid: string,
	chat_type: 1 | 2,
	content: string,
): Promise<void> {
	const body = {
		chat_type,
		msgtype: "markdown" as const,
		markdown: { content },
	};
	return acked(client.sendMessage(chatid, body));
}

function options(credentials: Credentials): WSClientOptions {
	return {
		botId: credentials.botId ?? "",
		secret: credentials.secret ?? "",
		// a refused subscribe fails at once: the SDK's retries would only hide wrong credentials
		maxAuthFailureAttempts: 0,
		maxReconnectAttempts: -1,
		logger: {
			debug() {},
			info() {},
			warn: console.warn,
			error: console.error,
		},
	};
}

// shortcut: WeCom does not document its subscribe error codes, so any refused subscribe (a rate limit too) reads as wrong credentials
const refused = (botId: string, last: Error | undefined) =>
	new Error(
		`WeCom refused AI bot ${botId}'s id and secret${last ? `: ${last.message}` : ""}`,
	);

/** The incoming frame a session was last written to through, and the reply streamed on it since its `thought`. */
type Held = {
	client: WSClient;
	frames: Map<string, WsFrameHeaders & { stream?: { id: string; at: number } }>;
};

/** WeCom as a WorkSource; `create` makes the SDK's client, a fake in tests. */
export function wecomSource(
	create: (options: WSClientOptions) => WSClient = (o) => new WSClient(o),
): WorkSource {
	// this process's live connections, by bot id
	const live = new Map<string, Held>();

	function held(botId: string | undefined): Held {
		const connection = botId && live.get(botId);
		if (!connection)
			throw new Error(
				`This process holds no connection to WeCom AI bot ${botId}: only the one that does can post as it`,
			);
		return connection;
	}

	const connect: StreamIngress["connect"] = async (auth, onEvent, signal) => {
		const { credentials } = await auth();
		const botId = credentials.botId ?? "";
		const client = create(options(credentials));
		const connection: Held = { client, frames: new Map() };
		await new Promise<void>((resolve, reject) => {
			let last: Error | undefined;
			let retry: ReturnType<typeof setTimeout> | undefined;
			let chain = Promise.resolve();
			const end = (error?: unknown) => {
				clearTimeout(retry);
				signal.removeEventListener("abort", stop);
				client.removeAllListeners();
				client.disconnect();
				if (live.get(botId) === connection) live.delete(botId);
				if (error) reject(error);
				else resolve();
			};
			const stop = () => end();
			if (signal.aborted) return end();
			signal.addEventListener("abort", stop, { once: true });
			client.on("authenticated", () => live.set(botId, connection));
			client.on("error", (error) => {
				if (error instanceof WSAuthFailureError) end(refused(botId, last));
				else last = error;
			});
			// the SDK reconnects a dropped connection itself but not one a newer connection kicked; its `connect` does nothing while it
			// is reconnecting, so this takes the bot back only after a kick
			// shortcut: two processes holding the same bot take it from each other every KICKED_RETRY_MS; hold one per bot across workers
			client.on("disconnected", () => {
				clearTimeout(retry);
				retry = setTimeout(() => client.connect(), KICKED_RETRY_MS);
			});
			client.on("message", (frame) => {
				const event = sessionEvent(frame);
				if (!event) return;
				connection.frames.set(event.sessionId, {
					headers: { req_id: frame.headers.req_id },
				});
				// WeCom has no redelivery to lean on: an event Orqestra could not take ends the connection, to be seen
				chain = chain.then(() => onEvent(event)).catch(end);
			});
			client.connect();
		});
	};

	return {
		kind: "wecom",
		name: "WeCom",
		install: {
			mode: "credentials",
			fields: [
				{ name: "botId", secret: false },
				{ name: "secret", secret: true },
			],
			// an authenticated subscribe, then closed; the subscribe's answer names nothing, so the bot is named by its id
			// shortcut: WeCom keeps one connection per bot, so proving them kicks a worker's, which takes it back after KICKED_RETRY_MS
			async workspace({ credentials }) {
				const client = create(options(credentials));
				try {
					await new Promise<void>((resolve, reject) => {
						let last: Error | undefined;
						const timer = setTimeout(
							() =>
								reject(
									new Error(
										`WeCom did not answer AI bot ${credentials.botId}'s subscribe${last ? `: ${last.message}` : ""}`,
									),
								),
							PROVE_MS,
						);
						client.on("authenticated", () => {
							clearTimeout(timer);
							resolve();
						});
						client.on("error", (error) => {
							if (!(error instanceof WSAuthFailureError)) last = error;
							else {
								clearTimeout(timer);
								reject(refused(credentials.botId ?? "", last));
							}
						});
						client.connect();
					});
				} finally {
					client.removeAllListeners();
					client.disconnect();
				}
				return `WeCom AI bot ${credentials.botId}`;
			},
		},
		ingress: { mode: "stream", connect },
		// a WeCom one-to-one chat is read by that person alone; WeCom pushes into one only after they wrote to the bot there
		proof: {
			mode: "private-link",
			async tell({ credentials }, person, body) {
				await push(held(credentials.botId).client, person.id, 1, cut(body));
			},
		},
		sharedScopes: "listed",

		// A reply tied to the incoming frame must be streamed and finished within 10 minutes, and a Run takes minutes to hours: the
		// `thought` opens a reply streamed on the session's last frame, which the closing activity finishes while it can, else it pushes
		// the answer into the chat. WeCom pushes only into a chat the person wrote to the bot in, 30 a minute per chat.
		// shortcut: post works only in a process holding the bot's connection, as the frames and the socket live there; route posts to
		// that process once Runs end on other workers
		async post({ credentials }, sessionId, { type, body }) {
			const content = cut(body);
			if (type === "thought") {
				// shown only on the frame the session was written to through: a process holding no connection shows none
				const connection = live.get(credentials.botId ?? "");
				const frame = connection?.frames.get(sessionId);
				if (!connection || !frame || frame.stream) return;
				frame.stream = { id: generateReqId("stream"), at: Date.now() };
				return acked(
					connection.client.replyStream(frame, frame.stream.id, content),
				);
			}
			const { client, frames } = held(credentials.botId);
			const frame = frames.get(sessionId);
			if (frame?.stream && Date.now() - frame.stream.at < STREAM_MS) {
				frames.delete(sessionId);
				try {
					return await acked(
						client.replyStream(frame, frame.stream.id, content, true),
					);
				} catch {
					// pushed instead: a stream WeCom ended early takes nothing more
				}
			}
			const { chatid, chat_type } = chatOf(sessionId);
			await push(client, chatid, chat_type, content);
		},

		// who wrote, where, the repository the chat works in, and what they wrote
		firstMessage: (event: SessionEvent, repo) =>
			[
				event.shared
					? `WeCom message from ${event.from?.name} in group chat ${event.scope}`
					: `WeCom message from ${event.from?.name}`,
				repo && `Repository: ${repo}`,
				event.text,
			]
				.filter(Boolean)
				.join("\n\n"),
	};
}

export const wecom = wecomSource();
