// A scripted Feishu, its open API reachable through `fetch`, and the events its long connection pushes, for testing the app without it.
import { randomUUID } from "node:crypto";

/**
 * Tenant tokens are issued for `appId` and `appSecret`; the bot is `bot`; `users` the people whose names the app may read.
 * `messages` holds each message the bot sent: to a chat or a person (`receiveIdType` and `receiveId`), or as a reply to `replyTo`.
 */
export function fakeFeishu({
	appId = "cli_app",
	appSecret = "app-s3cret",
	bot = { app_name: "Orqestra", open_id: "ou_bot" },
	users = { ou_uma: "Uma" } as Record<string, string>,
}: {
	appId?: string;
	appSecret?: string;
	bot?: { app_name: string; open_id: string };
	users?: Record<string, string>;
} = {}) {
	let n = 0;
	const ok = (rest: Record<string, unknown>) =>
		Response.json({ code: 0, msg: "ok", ...rest });
	const feishu = {
		appId,
		appSecret,
		bot,
		users,
		tenantTokens: new Set<string>(),
		messages: [] as {
			receiveIdType?: string;
			receiveId?: string;
			replyTo?: string;
			replyInThread?: boolean;
			msgType: string;
			/** The content as sent, a JSON string. */
			content: string;
		}[],
		async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
			const url = new URL(String(input));
			const path = url.pathname.replace(/^\/open-apis/, "");
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			if (path === "/auth/v3/tenant_access_token/internal") {
				if (
					body.app_id !== feishu.appId ||
					body.app_secret !== feishu.appSecret
				)
					return Response.json({ code: 10014, msg: "app secret invalid" });
				n++;
				feishu.tenantTokens.add(`t-${n}`);
				return ok({ tenant_access_token: `t-${n}`, expire: 7200 });
			}
			const token = new Headers(init?.headers)
				.get("authorization")
				?.replace(/^Bearer /, "");
			if (!token || !feishu.tenantTokens.has(token))
				return Response.json(
					{ code: 99991663, msg: "Invalid access token for authorization." },
					{ status: 400 },
				);
			if (path === "/bot/v3/info") return ok({ bot: feishu.bot });
			const user = path.match(/^\/contact\/v3\/users\/([^/]+)$/);
			if (user) {
				const name = feishu.users[decodeURIComponent(user[1] ?? "")];
				return name
					? ok({ data: { user: { name } } })
					: Response.json(
							{ code: 41050, msg: "no user authority error" },
							{ status: 400 },
						);
			}
			const reply = path.match(/^\/im\/v1\/messages\/([^/]+)\/reply$/);
			if (path === "/im/v1/messages" || reply) {
				feishu.messages.push({
					...(reply
						? {
								replyTo: decodeURIComponent(reply[1] ?? ""),
								replyInThread: body.reply_in_thread,
							}
						: {
								receiveIdType: url.searchParams.get("receive_id_type") ?? "",
								receiveId: body.receive_id,
							}),
					msgType: body.msg_type,
					content: body.content,
				});
				return ok({ data: { message_id: `om_${randomUUID()}` } });
			}
			return Response.json({ code: 404, msg: "not found" }, { status: 404 });
		},
	};
	return feishu;
}

/**
 * An `im.message.receive_v1` event as the WSClient hands it to a handler (its header and body merged), with fewer fields. `text` may
 * hold `@_user_1`, the placeholder of `mentions`' first.
 */
export function messageEvent({
	text = "hello",
	chatType = "p2p",
	chatId = "oc_chat",
	messageId = `om_${randomUUID()}`,
	rootId,
	senderId = "ou_uma",
	senderType = "user",
	mentions = [],
	messageType = "text",
	content = JSON.stringify({ text }),
}: {
	text?: string;
	chatType?: "p2p" | "group";
	chatId?: string;
	messageId?: string;
	rootId?: string;
	senderId?: string;
	senderType?: "user" | "bot";
	mentions?: { openId: string; name: string }[];
	messageType?: string;
	/** The raw content, a JSON string; built from `text` by default. */
	content?: string;
} = {}) {
	return {
		schema: "2.0",
		event_id: randomUUID(),
		event_type: "im.message.receive_v1",
		create_time: String(Date.now()),
		token: "",
		app_id: "cli_app",
		tenant_key: "tenant-1",
		sender: {
			sender_id: { union_id: "on_1", user_id: "u1", open_id: senderId },
			sender_type: senderType,
			tenant_key: "tenant-1",
		},
		message: {
			message_id: messageId,
			...(rootId && { root_id: rootId, parent_id: rootId }),
			create_time: String(Date.now()),
			chat_id: chatId,
			chat_type: chatType,
			message_type: messageType,
			content,
			mentions: mentions.map((m, i) => ({
				key: `@_user_${i + 1}`,
				id: { union_id: "on_x", user_id: "ux", open_id: m.openId },
				name: m.name,
				tenant_key: "tenant-1",
			})),
		},
	};
}
