import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import type { Db, Tx } from "./index.ts";

type Channel = { subscribers: Set<() => void>; listening: Promise<unknown> };
type Listener = {
	client: Promise<PoolClient>;
	channels: Map<string, Channel>;
};
// one connection per pool LISTENs for every live on it, so capabilities do not each hold one
const listeners = new WeakMap<Db, Listener>();

/** Calls `onNotify` on every NOTIFY on `channel` once it resolves; resolves to the unsubscribe. */
async function listen(db: Db, channel: string, onNotify: () => void) {
	let l = listeners.get(db);
	if (!l) {
		const channels: Listener["channels"] = new Map();
		const client = db.$client.connect().then((c) => {
			c.on("notification", (n) => {
				for (const fn of channels.get(n.channel)?.subscribers ?? []) fn();
			});
			return c;
		});
		l = { client, channels };
		listeners.set(db, l);
		// a failed connect is retried by the next live
		client.catch(() => listeners.delete(db));
	}
	const { client, channels } = l;
	let c = channels.get(channel);
	if (!c) {
		const listening = client.then((cl) => cl.query(`LISTEN ${channel}`));
		c = { subscribers: new Set(), listening };
		channels.set(channel, c);
		listening.catch(() => channels.delete(channel));
	}
	await c.listening;
	const { subscribers } = c;
	subscribers.add(onNotify);
	return async () => {
		subscribers.delete(onNotify);
		if (subscribers.size) return;
		channels.delete(channel);
		const cl = await client;
		if (channels.size) {
			await cl.query(`UNLISTEN ${channel}`);
			return;
		}
		// lives closing at once each see no channel left; only the first releases
		if (listeners.get(db) !== l) return;
		listeners.delete(db);
		cl.release(true);
	};
}

/**
 * A snapshot of what `load` reads, shared by every process: loaded on the first `current()`, then
 * reloaded on every NOTIFY on `channel`, which `write` sends once its transaction is committed.
 * `current()` rejects when the first load fails; a failed reload keeps the previous snapshot.
 * Whoever holds a snapshot keeps it, so a reload never changes a Run in progress.
 */
export function live<T>(
	db: Db,
	{ channel, load }: { channel: string; load: () => Promise<T> },
) {
	let current: Promise<T> | undefined;
	let unlisten: Promise<() => Promise<void>> | undefined;
	let latest = 0;
	let newest: Promise<void> = Promise.resolve();
	/** Resolves once the snapshot is at least as fresh as this reload. */
	const refresh = () => {
		const next = load();
		const seq = ++latest;
		newest = next.then(
			() => {
				// an older reload finishing late must not replace a newer one
				if (seq === latest) current = next;
				else return newest;
			},
			(error) => console.error(`${channel}: reload failed`, error),
		);
		return newest;
	};
	const start = () => {
		// LISTEN before the first load so no change slips in between
		// shortcut: a dropped connection silently stops reloads; reconnect if that shows up in practice
		unlisten = listen(db, channel, () => void refresh());
		return unlisten.then(load);
	};
	return {
		current: () => (current ??= start()),
		/** Runs `fn` in a transaction, then tells every process to reload, and reloads this one before resolving. */
		write: async <R>(fn: (tx: Tx) => Promise<R>): Promise<R> => {
			const result = await db.transaction(fn);
			await db.execute(sql`select pg_notify(${channel}, '')`);
			if (current) await refresh();
			return result;
		},
		close: async () => {
			const stop = await unlisten?.catch(() => undefined);
			unlisten = undefined;
			await stop?.();
		},
	};
}

export type Live<T> = ReturnType<typeof live<T>>;
