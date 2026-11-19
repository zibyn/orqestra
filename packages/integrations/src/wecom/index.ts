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

/** The most WeCom takes in a markdown message: 20480 bytes of UTF-8. */
const MAX_BYTES = 20_480;

/** WeCom takes 30 pushes a minute into a chat: one each two seconds keeps within it. */
const PUSH_GAP_MS = 2_000;

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
 * A chat has no threads, so a one-to-one chat is one rolling session per person and a group one per person in it; `/new` or `/reset`
 * starts it afresh and `/stop` stops its Run.
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
	const text = (group && said ? unmentioned(said) : said)?.trim();
	if (!text) return null;
	const reset = text === "/new" || text === "/reset";
	const stop = text === "/stop";
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
		text: reset || stop ? null : text,
		stop,
	};
}

/**
 * A group message's text without the bot's @-mention, as chatgpt-on-wechat's wecom_bot cuts it. WeCom delivers a group message only
 * when it @-mentions the bot, as plain text with no mention list or bot name ("@RobotA hello" in WeCom's example), so the "@name"
 * opening the text is taken for the bot's, else one ending it after a space ("/stop @RobotA"); any other "@" (an e-mail address,
 * another member's mention) is what the person wrote.
 */
function unmentioned(text: string): string {
	const cut = text.replace(/^\s*@\S+/, "");
	return cut !== text ? cut : text.replace(/(?:^|\s)@\S+\s*$/, "");
}

/** Where a session's answers are pushed: a one-to-one chat by the person's userid (chat_type 1), a group by its chatid (2). */
function chatOf(sessionId: string): { chatid: string; chat_type: 1 | 2 } {
	const [kind, chatid = "", ...rest] = sessionId.split(":");
	if (kind === "single" && chatid) return { chatid, chat_type: 1 };
	if (kind === "group" && chatid && rest.length)
		return { chatid, chat_type: 2 };
	throw new Error(`Not a WeCom session: ${sessionId}`);
}

const bytes = (text: string) => Buffer.byteLength(text);
const CLOSE_FENCE = "\n```";

/** A line in parts of at most `max` bytes of UTF-8, cut between characters. */
function* parts(line: string, max: number) {
	if (bytes(line) <= max) {
		yield line;
		return;
	}
	let part = "";
	let size = 0;
	for (const char of line) {
		if (size + bytes(char) > max) {
			yield part;
			part = "";
			size = 0;
		}
		part += char;
		size += bytes(char);
	}
	yield part;
}

/**
 * Markdown in messages of at most MAX_BYTES of UTF-8, split between lines (a line too long for one, between characters); a code block
 * open at a split is closed there and opened again in the next.
 */
export function split(body: string): string[] {
	if (bytes(body) <= MAX_BYTES) return [body];
	const room = MAX_BYTES - bytes(CLOSE_FENCE);
	const pieces: string[] = [];
	let piece: string | undefined;
	let size = 0;
	// the line that opened the code block the text so far ends in
	let fence: string | undefined;
	for (const line of body.split("\n")) {
		for (const part of parts(line, room - bytes(fence ?? "") - 1)) {
			const n = bytes(part);
			if (piece !== undefined && size + 1 + n > room) {
				pieces.push(fence ? piece + CLOSE_FENCE : piece);
				piece = fence;
				size = bytes(fence ?? "");
			}
			if (piece === undefined) [piece, size] = [part, n];
			else [piece, size] = [`${piece}\n${part}`, size + 1 + n];
		}
		if (line.trimStart().startsWith("```")) fence = fence ? undefined : line;
	}
	if (piece !== undefined) pieces.push(piece);
	return pieces;
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

/** `connect`'s end when another connection took the bot from it: WeCom keeps one per bot. */
export class ConnectedElsewhere extends Error {
	override name = "ConnectedElsewhere";
	constructor(botId: string) {
		super(
			`WeCom AI bot ${botId} is connected elsewhere: a newer connection took it over`,
		);
	}
}

/** A connection WeCom acked the subscribe of, and the frame each session was last written to through until its `thought` answers it. */
type Held = { client: WSClient; frames: Map<string, WsFrameHeaders> };

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

	// when each chat may next be pushed to, by bot, chat type and chat
	const nextPush = new Map<string, number>();

	/** Pushes Markdown into a chat in as many messages as it takes, spaced to keep within WeCom's 30 pushes a minute per chat. */
	// shortcut: no cap on the messages, so a reply of hundreds of KB holds the chat for minutes; cap it with a note if one does
	async function push(
		client: WSClient,
		botId: string,
		chatid: string,
		chat_type: 1 | 2,
		body: string,
	) {
		const chat = `${botId}:${chat_type}:${chatid}`;
		for (const content of split(body)) {
			const now = Date.now();
			for (const [key, at] of nextPush) if (at <= now) nextPush.delete(key);
			const at = Math.max(now, nextPush.get(chat) ?? 0);
			nextPush.set(chat, at + PUSH_GAP_MS);
			if (at > now) await new Promise((wait) => setTimeout(wait, at - now));
			// `chat_type` is WeCom's own, which the SDK's type leaves out: a userid could equal a group's chatid
			const message = {
				chat_type,
				msgtype: "markdown" as const,
				markdown: { content },
			};
			await acked(client.sendMessage(chatid, message));
		}
	}

	const connect: StreamIngress["connect"] = async (auth, onEvent, signal) => {
		const { credentials } = await auth();
		const botId = credentials.botId ?? "";
		const client = create(options(credentials));
		const connection: Held = { client, frames: new Map() };
		await new Promise<void>((resolve, reject) => {
			let last: Error | undefined;
			let chain = Promise.resolve();
			const end = (error?: unknown) => {
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
			// posts only once WeCom acked the subscribe, again after each reconnect, not while the SDK reconnects a dropped connection
			client.on("authenticated", () => live.set(botId, connection));
			client.on("disconnected", () => {
				if (live.get(botId) === connection) live.delete(botId);
			});
			client.on("error", (error) => {
				if (error instanceof WSAuthFailureError) end(refused(botId, last));
				else last = error;
			});
			// a newer connection took the bot, and the SDK does not reconnect: taking it back would kick that one, and two holders would
			// kick each other forever, so this ends and the core backs off before connecting again
			client.on("event.disconnected_event", () =>
				end(new ConnectedElsewhere(botId)),
			);
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
			// WeCom keeps one connection per bot, so proving them kicks a worker's, which the core connects again after its back-off
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
		ingress: { mode: "stream", exclusive: true, connect },
		// a WeCom one-to-one chat is read by that person alone; WeCom pushes into one only after they wrote to the bot there
		proof: {
			mode: "private-link",
			async tell({ credentials }, person, body) {
				const botId = credentials.botId ?? "";
				await push(held(botId).client, botId, person.id, 1, body);
			},
		},
		sharedScopes: "listed",

		// Pushed, as Qwen Code does: a reply on the incoming frame takes updates for 6 minutes (WeCom answers 846608 past it, not at the
		// documented 10) and a Run takes minutes to hours. So the `thought` answers the frame at once with a finished line, leaving no
		// loading bubble, and the closing activity is pushed into the chat. The core sends every post to the process holding the bot.
		async post({ credentials }, sessionId, { type, body }) {
			const botId = credentials.botId ?? "";
			if (type === "thought") {
				// once per message, on its frame: one this process never got shows nothing
				const connection = live.get(botId);
				const frame = connection?.frames.get(sessionId);
				if (!connection || !frame) return;
				connection.frames.delete(sessionId);
				// only a sign of life: a frame WeCom no longer answers on fails nothing
				await connection.client
					.replyStream(frame, generateReqId("stream"), body, true)
					.catch(() => {});
				return;
			}
			const { chatid, chat_type } = chatOf(sessionId);
			await push(held(botId).client, botId, chatid, chat_type, body);
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
