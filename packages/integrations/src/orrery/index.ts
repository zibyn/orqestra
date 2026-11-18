// A thin client for orrery's REST API (orrery docs/spec/api.md §3–§5): the Sandbox Provider. orrery has no TS SDK.

import type {
	CreateSandbox,
	Exec,
	ExecRequest,
	Fetch,
	Frame,
	Sandbox,
	SandboxClient,
	SandboxState,
} from "../ports.ts";

/** A request body: bytes, or a stream sent as it is read. */
type Body = Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

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
}): SandboxClient {
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
			stream,
		}: {
			query?: Record<string, string | number | undefined>;
			json?: unknown;
			body?: Body;
			signal?: AbortSignal;
			/** The timeout bounds only the wait for the response to start, not reading its body. */
			stream?: boolean;
		} = {},
	) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {}))
			if (v !== undefined) params.set(k, String(v));
		const search = params.size ? `?${params}` : "";
		const started = new AbortController();
		const timer = stream
			? setTimeout(
					() =>
						started.abort(
							new DOMException("The operation timed out.", "TimeoutError"),
						),
					timeoutMs,
				)
			: undefined;
		const timeout = stream ? started.signal : AbortSignal.timeout(timeoutMs);
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
		} as RequestInit).finally(() => clearTimeout(timer));
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
		me: (o: Opts = {}) =>
			json<{ id: string; name: string }>("GET", "/users/me", o),
		putSecret: async (name: string, value: string, o: Opts = {}) => {
			await send("PUT", `/secrets/${id(name)}`, { json: { value }, ...o });
		},

		createSandbox: (request: CreateSandbox, o: Opts = {}) =>
			json<Sandbox>("POST", "/sandboxes", { json: request, ...o }),
		getSandbox: (sandbox: string, o: Opts & { waitFor?: SandboxState } = {}) =>
			json<Sandbox>("GET", `/sandboxes/${id(sandbox)}`, {
				query: { wait_for: o.waitFor },
				signal: o.signal,
			}),
		startSandbox: (sandbox: string, o: Opts = {}) =>
			json<Sandbox>("POST", `/sandboxes/${id(sandbox)}/start`, o),
		deleteSandbox: (sandbox: string, o: Opts = {}) =>
			json<Sandbox>("DELETE", `/sandboxes/${id(sandbox)}`, o),

		createExec: (sandbox: string, request: ExecRequest, o: Opts = {}) =>
			json<Exec>("POST", `/sandboxes/${id(sandbox)}/execs`, {
				json: request,
				...o,
			}),
		getExec: (exec: string, o: Opts = {}) =>
			json<Exec>("GET", `/execs/${id(exec)}`, o),
		cancelExec: (exec: string, o: Opts = {}) =>
			json<Exec>("POST", `/execs/${id(exec)}/cancel`, o),
		execOutput: (exec: string, after = 0, o: Opts = {}) =>
			json<Frame[]>("GET", `/execs/${id(exec)}/output`, {
				query: { after },
				...o,
			}),

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
		openFile: async (sandbox: string, path: string, o: Opts = {}) => {
			const response = await send("GET", files(sandbox, "/content"), {
				query: { path },
				stream: true,
				...o,
			});
			const length = response.headers.get("content-length");
			return {
				body: response.body ?? new ReadableStream<Uint8Array>(),
				size: length === null ? undefined : Number(length),
			};
		},
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

export type SandboxTestResult =
	| { ok: true }
	| {
			ok: false;
			reason: "auth" | "unreachable" | "timeout" | "failed";
			detail: string;
	  };

/** Checks orrery's address and API Token within `timeoutMs`; never throws. */
export async function testSandboxProvider(
	provider: { url: string; token: string },
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
