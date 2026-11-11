// An orrery client and object storage kept in memory, and a scripted MCP Server, for testing what uses Sandboxes,
// Attachments and MCP Servers without an orrery, S3 or a real MCP Server.

import type {
	ConnectionStore,
	PendingAuthorization,
	StoredConnection,
} from "./oauth.ts";
import {
	type Exec,
	type Frame,
	type Orrery,
	OrreryError,
	type SandboxState,
} from "./orrery.ts";
import type { ObjectStore } from "./store.ts";

export * from "./fake-mcp.ts";
export * from "./fake-oauth.ts";

type Ran = {
	stdout?: string;
	stderr?: string;
	exit_code?: number;
	cause?: string;
	/** Keeps running until canceled. */
	running?: boolean;
};

/**
 * Sandboxes become ready on the first wait, keep their files across a stop and start (`stop` plays Idle Stop),
 * and unpack uploaded tars into their files. Commands answer what `exec` says. Polling a command with an aborted signal throws, as fetch does. `down` makes every call fail
 * as an unreachable orrery does. `calls` lists the calls made, as `method id…`.
 */
export function memoryOrrery({
	exec = () => ({}),
}: {
	exec?: (command: string, files: Map<string, Uint8Array<ArrayBuffer>>) => Ran;
} = {}) {
	const sandboxes = new Map<
		string,
		{
			state: SandboxState;
			cause: string | null;
			files: Map<string, Uint8Array<ArrayBuffer>>;
		}
	>();
	const execs = new Map<string, { exec: Exec; frames: Frame[] }>();
	const calls: string[] = [];
	let down = false;
	let n = 0;

	const find = (id: string) => {
		const s = sandboxes.get(id);
		if (!s) throw new OrreryError(404, "not_found", "no such sandbox");
		return s;
	};
	const ready = (id: string) => {
		const s = find(id);
		if (s.state !== "ready")
			throw new OrreryError(409, "conflict", `sandbox is ${s.state}`);
		return s;
	};
	const view = (id: string) => {
		const { state, cause } = find(id);
		return { id, state, cause };
	};
	const call = (name: string, ...args: unknown[]) => {
		calls.push([name, ...args].join(" "));
		if (down)
			throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
	};

	const client: Orrery = {
		me: async () => {
			call("me");
			return { id: "u1", name: "orqestra" };
		},
		createSandbox: async (request) => {
			call("createSandbox", JSON.stringify(request));
			const id = `sb${++n}`;
			sandboxes.set(id, { state: "pending", cause: null, files: new Map() });
			return view(id);
		},
		getSandbox: async (id, o = {}) => {
			call("getSandbox", id, ...(o.waitFor ? [o.waitFor] : []));
			const s = find(id);
			if (o.waitFor && s.state === "pending") s.state = "ready";
			if (o.waitFor && s.state === "stopping") s.state = "stopped";
			return view(id);
		},
		startSandbox: async (id) => {
			call("startSandbox", id);
			const s = find(id);
			if (s.state === "stopped") s.state = "pending";
			return view(id);
		},
		deleteSandbox: async (id) => {
			call("deleteSandbox", id);
			find(id).state = "deleted";
			return view(id);
		},
		createExec: async (id, request) => {
			call("createExec", id, request.argv.at(-1));
			const s = ready(id);
			const ran = exec(request.argv.at(-1) ?? "", s.files);
			const frames: Frame[] = [];
			let seq = 0;
			for (const stream of ["stdout", "stderr"] as const) {
				const data = ran[stream];
				if (!data) continue;
				frames.push({ seq, stream, data });
				seq += 5 + Buffer.byteLength(data);
			}
			const e: Exec = {
				id: `ex${++n}`,
				state: ran.running ? "running" : "finished",
				result: ran.running
					? null
					: {
							cause: ran.cause ?? "exited",
							exit_code: ran.cause ? undefined : (ran.exit_code ?? 0),
						},
				log_truncated: false,
			};
			execs.set(e.id, { exec: e, frames });
			return { ...e, state: "running", result: null };
		},
		getExec: async (id, o) => {
			call("getExec", id);
			o?.signal?.throwIfAborted();
			return execs.get(id)?.exec as Exec;
		},
		cancelExec: async (id) => {
			call("cancelExec", id);
			const e = execs.get(id)?.exec as Exec;
			if (e.state === "running")
				Object.assign(e, { state: "finished", result: { cause: "canceled" } });
			return e;
		},
		execOutput: async (id, after = 0) => {
			call("execOutput", id, after);
			return (execs.get(id)?.frames ?? []).filter((f) => f.seq >= after);
		},
		readFile: async (id, path) => {
			call("readFile", id, path);
			const file = ready(id).files.get(path);
			if (!file)
				throw new OrreryError(404, "not_found", `no such file: ${path}`);
			return file;
		},
		listFiles: async (id, path) => {
			call("listFiles", id, path);
			const prefix = `${path}/`;
			const names = [...ready(id).files.keys()]
				.filter((p) => p.startsWith(prefix))
				.map((p) => p.slice(prefix.length).split("/")[0]);
			if (!names.length)
				throw new OrreryError(404, "not_found", `no such directory: ${path}`);
			return [...new Set(names)].map((name) => ({ name, type: "file" }));
		},
		openFile: async (id, path) => {
			call("openFile", id, path);
			const file = ready(id).files.get(path);
			if (!file)
				throw new OrreryError(404, "not_found", `no such file: ${path}`);
			return {
				body: new Response(file).body as ReadableStream<Uint8Array>,
				size: file.length,
			};
		},
		writeFile: async (id, path, data) => {
			call("writeFile", id, path);
			const files = ready(id).files;
			// a stream that fails midway writes nothing, as orrery's temporary file does
			files.set(
				path,
				data instanceof ReadableStream
					? new Uint8Array(await new Response(data).arrayBuffer())
					: data,
			);
		},
		uploadArchive: async (id, path, tar) => {
			call("uploadArchive", id, path);
			const files = ready(id).files;
			for (let at = 0; at + 512 <= tar.length && tar[at]; ) {
				const field = (from: number, len: number) =>
					Buffer.from(tar.subarray(at + from, at + from + len))
						.toString()
						.replace(/\0.*$/s, "");
				const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/");
				const size = Number.parseInt(field(124, 12), 8);
				files.set(`${path}/${name}`, tar.slice(at + 512, at + 512 + size));
				at += 512 + Math.ceil(size / 512) * 512;
			}
		},
	};
	return {
		client,
		calls,
		/** Files by path relative to /workspace. */
		files: (id: string) => find(id).files,
		state: (id: string) => find(id).state,
		/** Idle Stop. */
		stop: (id: string) => {
			find(id).state = "stopped";
		},
		/** Fails it, as a lost Workspace does. */
		fail: (id: string) => {
			Object.assign(find(id), { state: "failed", cause: "workspace_lost" });
		},
		set down(value: boolean) {
			down = value;
		},
	};
}

/** Object storage kept in memory, by key; `objects` shows what it holds. */
export function memoryStore() {
	const objects = new Map<string, Uint8Array<ArrayBuffer>>();
	const store: ObjectStore = {
		put: async (key, body) => {
			// a stream that fails midway stores nothing
			objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
		},
		get: async (key) => {
			const bytes = objects.get(key);
			return (
				bytes && {
					body: new Response(bytes).body as ReadableStream<Uint8Array>,
					size: bytes.length,
				}
			);
		},
		deletePrefix: async (prefix) => {
			for (const key of objects.keys())
				if (key.startsWith(prefix)) objects.delete(key);
		},
	};
	return { store, objects };
}

/** Connections, pending authorizations and registered Clients kept in memory; `connections` holds them by `${userId} ${serverId}`. */
export function memoryConnections() {
	const connections = new Map<string, StoredConnection>();
	const pending = new Map<string, PendingAuthorization>();
	const clients = new Map<
		string,
		Awaited<ReturnType<ConnectionStore["registeredClient"]>>
	>();
	const store: ConnectionStore = {
		connection: async (userId, serverId) =>
			connections.get(`${userId} ${serverId}`),
		saveConnection: async (userId, serverId, c) => {
			connections.set(`${userId} ${serverId}`, {
				...c,
				scope: c.scope ?? null,
				status: "connected",
				connectedAt: new Date(),
			});
		},
		addPending: async (p) => {
			for (const [state, q] of pending)
				if (q.userId === p.userId && q.serverId === p.serverId)
					pending.delete(state);
			pending.set(p.state, p);
		},
		takePending: async (state) => {
			const p = pending.get(state);
			pending.delete(state);
			return p;
		},
		registeredClient: async (serverId) => clients.get(serverId),
		saveRegisteredClient: async (serverId, client) => {
			clients.set(serverId, client);
		},
	};
	return Object.assign(store, { connections });
}
