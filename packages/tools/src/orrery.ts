// A thin client for orrery's REST API (orrery docs/spec/api.md §3–§5): the Sandbox Provider. orrery has no TS SDK.

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** A request body: bytes, or a stream sent as it is read. */
type Body = Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

/** The configured Sandbox Provider: orrery's address and API Token, and what each Sandbox is created with. */
export interface SandboxProvider {
	url: string;
	token: string;
	/** A Snapshot name or SnapshotVersion id; undefined uses orrery's default Platform Snapshot. */
	snapshot?: string;
	cpu: number;
	/** Bytes. */
	memory: number;
}

/** A non-2xx answer: `code` is orrery's (api.md §2, e.g. `conflict`, `unauthenticated`), "" when the body is not problem+json. */
export class OrreryError extends Error {
	override name = "OrreryError";
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: string,
	) {
		super(code ? `${status} ${code}: ${detail}` : `${status}: ${detail}`);
	}
}

export type SandboxState =
	| "pending"
	| "ready"
	| "stopping"
	| "stopped"
	| "deleting"
	| "deleted"
	| "failed";

/** The fields Orqestra reads; orrery sends more. */
export interface Sandbox {
	id: string;
	state: SandboxState;
	/** Why it stopped or failed, e.g. `quota_exceeded`, `runtime_lost`. */
	cause: string | null;
}

export interface CreateSandbox {
	name?: string;
	labels?: Record<string, string>;
	snapshot?: string;
	cpu: number;
	memory: number;
	/** Seconds idle before orrery stops it; 0 never. orrery's default is 900. */
	idle_stop?: number;
}

export interface ExecRequest {
	/** Not run through a shell. */
	argv: string[];
	env?: Record<string, string>;
	/** Relative to /workspace. */
	cwd?: string;
	/** Seconds; omitted means no limit. */
	timeout?: number;
	/** Written once, then closed. */
	stdin?: string;
}

export interface Exec {
	id: string;
	state: "pending" | "running" | "canceling" | "finished";
	/** Set once finished; `cause` is `exited`, `canceled`, `timed_out`, `oom_killed`, `start_failed`, … */
	result: { cause: string; exit_code?: number; signal?: number } | null;
	log_truncated: boolean;
}

/** One frame of an Exec's output; `data` is base64 when `encoding` says so (invalid UTF-8). */
export interface Frame {
	seq: number;
	stream: "stdout" | "stderr" | "truncated";
	data: string;
	encoding?: "base64";
}

/** A frame's bytes. */
export const frameBytes = (frame: Frame) =>
	frame.encoding === "base64"
		? Buffer.from(frame.data, "base64")
		: Buffer.from(frame.data, "utf8");

/** The `after` to read the output past this frame: seq + the 5-byte record header + its decoded length. */
export const frameEnd = (frame: Frame) =>
	frame.seq + 5 + frameBytes(frame).length;

/**
 * An orrery client. Every request gives up after `timeoutMs` (a TimeoutError), so it must exceed orrery's
 * 60-second `wait_for`; failures from orrery throw an OrreryError.
 */
export function orrery({
	url,
	token,
	fetch = globalThis.fetch,
	timeoutMs = 65_000,
}: {
	url: string;
	token: string;
	fetch?: Fetch;
	timeoutMs?: number;
}) {
	const base = `${url.replace(/\/+$/, "")}/api/v1`;
	const id = encodeURIComponent;

	async function send(
		method: string,
		path: string,
		{
			query,
			json,
			body,
			signal,
		}: {
			query?: Record<string, string | number | undefined>;
			json?: unknown;
			body?: Body;
			signal?: AbortSignal;
		} = {},
	) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {}))
			if (v !== undefined) params.set(k, String(v));
		const search = params.size ? `?${params}` : "";
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await fetch(`${base}${path}${search}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(json !== undefined && { "content-type": "application/json" }),
			},
			body: json !== undefined ? JSON.stringify(json) : body,
			// fetch needs it for a streamed body; TS's RequestInit lacks it
			...(body instanceof ReadableStream && { duplex: "half" }),
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		} as RequestInit);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let problem: { code?: string; detail?: string } = {};
			try {
				problem = JSON.parse(text);
			} catch {}
			throw new OrreryError(
				response.status,
				problem.code ?? "",
				problem.detail || text || response.statusText,
			);
		}
		return response;
	}
	const json = async <T>(...args: Parameters<typeof send>) =>
		(await (await send(...args)).json()) as T;
	type Opts = { signal?: AbortSignal };
	const files = (sandbox: string, suffix: string) =>
		`/sandboxes/${id(sandbox)}/files${suffix}`;

	return {
		/** The User the API Token belongs to. */
		me: (o: Opts = {}) =>
			json<{ id: string; name: string }>("GET", "/users/me", o),

		/** Returns it `pending`; with no `workspace` orrery makes a temporary one, deleted with it. */
		createSandbox: (request: CreateSandbox, o: Opts = {}) =>
			json<Sandbox>("POST", "/sandboxes", { json: request, ...o }),
		/** `waitFor` long-polls up to 60 seconds, then answers the current state. */
		getSandbox: (sandbox: string, o: Opts & { waitFor?: SandboxState } = {}) =>
			json<Sandbox>("GET", `/sandboxes/${id(sandbox)}`, {
				query: { wait_for: o.waitFor },
				signal: o.signal,
			}),
		/** Back to `pending`; its Workspace files are kept. */
		startSandbox: (sandbox: string, o: Opts = {}) =>
			json<Sandbox>("POST", `/sandboxes/${id(sandbox)}/start`, o),
		/** Cancels its Execs, then deletes it with its temporary Workspace. */
		deleteSandbox: (sandbox: string, o: Opts = {}) =>
			json<Sandbox>("DELETE", `/sandboxes/${id(sandbox)}`, o),

		/** Fails with `conflict` unless the Sandbox is `ready`. */
		createExec: (sandbox: string, request: ExecRequest, o: Opts = {}) =>
			json<Exec>("POST", `/sandboxes/${id(sandbox)}/execs`, {
				json: request,
				...o,
			}),
		getExec: (exec: string, o: Opts = {}) =>
			json<Exec>("GET", `/execs/${id(exec)}`, o),
		cancelExec: (exec: string, o: Opts = {}) =>
			json<Exec>("POST", `/execs/${id(exec)}/cancel`, o),
		/** One page of output past `after` (0: from the start; next: `frameEnd` of the last frame); empty once caught up. */
		execOutput: (exec: string, after = 0, o: Opts = {}) =>
			json<Frame[]>("GET", `/execs/${id(exec)}/output`, {
				query: { after },
				...o,
			}),

		// Workspace files: `path` is relative to /workspace; the Sandbox must be `ready`
		/** A directory's entries; `not_found` when it does not exist. */
		listFiles: async (sandbox: string, path: string, o: Opts = {}) =>
			(
				await json<{ items: { name: string; type: string }[] }>(
					"GET",
					files(sandbox, ""),
					{ query: { path }, ...o },
				)
			).items,
		readFile: async (sandbox: string, path: string, o: Opts = {}) =>
			new Uint8Array(
				await (
					await send("GET", files(sandbox, "/content"), {
						query: { path },
						...o,
					})
				).arrayBuffer(),
			),
		/** Written to a temporary file, then renamed over `path`; one that fails midway leaves nothing. */
		writeFile: async (
			sandbox: string,
			path: string,
			data: Body,
			o: Opts = {},
		) => {
			await send("PUT", files(sandbox, "/content"), {
				query: { path },
				body: data,
				...o,
			});
		},
		/** Unpacks a tar into `path`. */
		uploadArchive: async (
			sandbox: string,
			path: string,
			tar: Uint8Array<ArrayBuffer>,
			o: Opts = {},
		) => {
			await send("PUT", files(sandbox, "/archive"), {
				query: { path },
				body: tar,
				...o,
			});
		},
	};
}

export type Orrery = ReturnType<typeof orrery>;

export type SandboxTestResult =
	| { ok: true }
	| {
			ok: false;
			reason: "auth" | "unreachable" | "timeout" | "failed";
			detail: string;
	  };

/** Checks orrery's address and API Token within `timeoutMs`; never throws. */
export async function testSandboxProvider(
	provider: Pick<SandboxProvider, "url" | "token">,
	{ fetch, timeoutMs = 15_000 }: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<SandboxTestResult> {
	try {
		await orrery({ ...provider, fetch, timeoutMs }).me();
		return { ok: true };
	} catch (error) {
		if (error instanceof OrreryError)
			return {
				ok: false,
				reason: [401, 403].includes(error.status) ? "auth" : "failed",
				detail: [401, 403].includes(error.status)
					? error.detail
					: error.message,
			};
		if (error instanceof Error && error.name === "TimeoutError")
			return { ok: false, reason: "timeout", detail: error.message };
		// fetch hides why it failed (ECONNREFUSED, ENOTFOUND) in its cause
		if (error instanceof TypeError)
			return {
				ok: false,
				reason: "unreachable",
				detail:
					error.cause instanceof Error
						? `${error.message}: ${error.cause.message}`
						: error.message,
			};
		return { ok: false, reason: "failed", detail: String(error) };
	}
}
