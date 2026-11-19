// A scripted WeCom, its AI bot's long connection played by a stand-in for the SDK's client, for testing the app without WeCom.
import { randomUUID } from "node:crypto";
import {
	type BaseMessage,
	type SendMsgBody,
	WSAuthFailureError,
	WSClient,
	type WSClientOptions,
	type WsFrame,
	type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";

type Wecom = ReturnType<typeof fakeWecom>;

/** The SDK's client with its socket replaced by `wecom`: connecting subscribes there, sending is recorded there. */
class FakeClient extends WSClient {
	connected = false;
	constructor(
		readonly given: WSClientOptions,
		private wecom: Wecom,
	) {
		super(given);
	}
	override connect() {
		queueMicrotask(() => {
			if (this.given.secret !== this.wecom.secret) {
				this.emit(
					"error",
					new Error("Authentication failed: invalid secret (code: 40001)"),
				);
				this.emit("error", new WSAuthFailureError(0));
				return;
			}
			// one connection per bot: the newest kicks the one before
			for (const other of this.wecom.clients)
				if (other !== this && other.connected) {
					other.connected = false;
					other.emit("disconnected", "New connection established");
				}
			this.connected = true;
			this.emit("authenticated");
		});
		return this;
	}
	override disconnect() {
		this.connected = false;
	}
	override get isConnected() {
		return this.connected;
	}
	private answer(record: () => void): Promise<WsFrame> {
		if (!this.connected)
			return Promise.reject(
				new Error("WebSocket not connected, unable to send data"),
			);
		const refusal = this.wecom.refuse.shift();
		// the SDK rejects with WeCom's receipt frame itself
		if (refusal) return Promise.reject({ headers: { req_id: "" }, ...refusal });
		record();
		return Promise.resolve({ headers: { req_id: "" }, errcode: 0 });
	}
	override sendMessage(chatid: string, body: SendMsgBody) {
		return this.answer(() => this.wecom.pushed.push({ chatid, body }));
	}
	override replyStream(
		frame: WsFrameHeaders,
		streamId: string,
		content: string,
		finish = false,
	) {
		return this.answer(() =>
			this.wecom.streamed.push({
				reqId: frame.headers.req_id,
				streamId,
				content,
				finish,
			}),
		);
	}
}

/**
 * `create` makes the clients the adapter connects with; `deliver` pushes a frame down whichever is connected. `pushed` holds each
 * `aibot_send_msg` (chatid and body); `streamed` each reply streamed on a frame; `refuse` the receipts WeCom answers the next sends with.
 */
export function fakeWecom({ secret = "bot-s3cret" }: { secret?: string } = {}) {
	const wecom = {
		secret,
		clients: [] as FakeClient[],
		pushed: [] as { chatid: string; body: SendMsgBody }[],
		streamed: [] as {
			reqId: string;
			streamId: string;
			content: string;
			finish: boolean;
		}[],
		refuse: [] as { errcode: number; errmsg: string }[],
		create(options: WSClientOptions): WSClient {
			const client = new FakeClient(options, wecom);
			wecom.clients.push(client);
			return client;
		},
		/** The client holding the bot's connection. */
		holder: () => wecom.clients.find((client) => client.connected),
		deliver(frame: WsFrame<BaseMessage>) {
			const holder = wecom.holder();
			if (!holder) throw new Error("no client holds the bot's connection");
			holder.emit("message", frame);
		},
	};
	return wecom;
}

/** A message callback as WeCom pushes it down the connection: text, in a one-to-one chat, or a group's when `chatid` is given. */
export function messageFrame({
	text = "Fix the login button",
	userid = "zhangsan",
	chatid,
	msgid = randomUUID(),
	body,
}: {
	text?: string;
	userid?: string;
	chatid?: string;
	msgid?: string;
	/** Fields in place of the text message's `msgtype` and `text`. */
	body?: { msgtype: string; [field: string]: unknown };
} = {}): WsFrame<BaseMessage> {
	return {
		cmd: "aibot_msg_callback",
		headers: { req_id: `req-${msgid}` },
		body: {
			msgid,
			aibotid: "bot-1",
			...(chatid ? { chatid, chattype: "group" } : { chattype: "single" }),
			from: { userid },
			...(body ?? { msgtype: "text", text: { content: text } }),
		},
	};
}
