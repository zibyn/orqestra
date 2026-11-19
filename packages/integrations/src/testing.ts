// Fakes of the outside systems, reachable through `fetch` or in memory, for testing what uses them without them.
import { randomUUID } from "node:crypto";
import type { Activity, Auth, SessionEvent, WorkSource } from "./ports.ts";

export * from "./linear/testing.ts";
export { memoryOrrery } from "./orrery/testing.ts";

/**
 * A scripted chat in memory that installs by credentials and pushes its events down a held connection, as Feishu, WeCom and email do;
 * its kind is "email". The Admin enters `appId` and the secret `appSecret`, traded for `tenant-<n>` lasting `tokenTtl` ms unless the
 * secret is not `appSecret`. People prove themselves by a private link, and a shared session answers only in an opened scope.
 * `push` sends an event down every open connection; `refuse` makes each connect throw.
 */
export function fakeChannel({
	workspace = "Acme Chat",
	appSecret = "app-s3cret",
	tokenTtl = 2 * 3_600_000,
}: {
	workspace?: string;
	appSecret?: string;
	tokenTtl?: number;
} = {}) {
	const issued = new Set<string>();
	const open = new Set<(event: SessionEvent) => Promise<void>>();
	const channel = {
		workspace,
		appSecret,
		refuse: false,
		/** The credentials of each trade for a token. */
		trades: [] as Record<string, string>[],
		/** What each connect acted as. */
		connects: [] as Auth[],
		/** How many connections are open. */
		get open() {
			return open.size;
		},
		posted: [] as { token: string; sessionId: string; activity: Activity }[],
		/** What was sent to a person alone. */
		told: [] as { person: { id: string; name: string }; body: string }[],
		async push(event: SessionEvent) {
			for (const send of open) await send(event);
		},
		source: undefined as unknown as WorkSource,
	};
	channel.source = {
		kind: "email",
		name: "Fake Chat",
		install: {
			mode: "credentials",
			fields: [
				{ name: "appId", secret: false },
				{ name: "appSecret", secret: true },
			],
			async token(credentials) {
				channel.trades.push(credentials);
				if (credentials.appSecret !== channel.appSecret)
					throw new Error("app secret refused");
				const accessToken = `tenant-${channel.trades.length}`;
				issued.add(accessToken);
				return { accessToken, expiresAt: Date.now() + tokenTtl };
			},
			async workspace({ token }) {
				if (!issued.has(token)) throw new Error("token refused");
				return channel.workspace;
			},
		},
		ingress: {
			mode: "stream",
			async connect(auth, onEvent, signal) {
				channel.connects.push(await auth());
				if (channel.refuse) throw new Error("connection refused");
				open.add(onEvent);
				await new Promise((resolve) => {
					if (signal.aborted) resolve(undefined);
					signal.addEventListener("abort", resolve, { once: true });
				});
				open.delete(onEvent);
			},
		},
		proof: {
			mode: "private-link",
			async tell(_auth, person, body) {
				channel.told.push({ person, body });
			},
		},
		sharedScopes: "listed",
		async post({ token }, sessionId, activity) {
			channel.posted.push({ token, sessionId, activity });
		},
		firstMessage: (event, repo) =>
			[repo && `Repository: ${repo}`, event.text].filter(Boolean).join("\n\n"),
	};
	return channel;
}

/** A message to the fake chat's app: from `chat-user-1` in a one-to-one chat, unless told otherwise. */
export const chatEvent = (event: Partial<SessionEvent> = {}): SessionEvent => ({
	id: randomUUID(),
	sessionId: "chat-1",
	action: "prompted",
	from: { id: "chat-user-1", name: "Uma" },
	issue: null,
	scope: "chat-1",
	shared: false,
	text: "Hello",
	stop: false,
	...event,
});
