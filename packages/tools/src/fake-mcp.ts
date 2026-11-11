// A scripted MCP Server reachable through `fetch`, for testing what talks MCP without a real one.
// Built on the official server SDK, so each era speaks the real wire format.
import {
	type CallToolResult,
	createMcpHandler,
	legacyStatelessFallback,
	ProtocolError,
	Server,
	type Tool,
} from "@modelcontextprotocol/server";

/** `legacy` speaks only 2025-11-25 and older, `modern` only 2026-07-28, `dual` both. */
export type McpEra = "legacy" | "dual" | "modern";

/** A Tool call's answer: a result, a request for more input (2026-07-28 only), or a task (2026-07-28 Tasks only). */
export type FakeCallAnswer =
	| CallToolResult
	| { inputRequired: true }
	| { task: FakeTask };

/** A task's state as `tasks/get` reports it; change it to move the task along. */
export type FakeTask = {
	status: "working" | "input_required" | "completed" | "failed" | "cancelled";
	result?: CallToolResult;
	error?: { code: number; message: string };
	pollIntervalMs?: number;
};

export type FakeTool = Tool & {
	call?: (
		args: Record<string, unknown>,
		signal: AbortSignal,
	) => FakeCallAnswer | Promise<FakeCallAnswer>;
};

const TASKS = "io.modelcontextprotocol/tasks";
const anything = {
	"~standard": {
		version: 1 as const,
		vendor: "orqestra",
		validate: (value: unknown) => ({ value }),
	},
};

/**
 * `requests` records every request as it arrived: its JSON-RPC method and params, URL and headers. `tasks` holds the tasks
 * handed out by id (`task-1`, …). `down` makes every request fail as an unreachable server does; `status` answers
 * every request with that HTTP status; `supported` answers every request with -32022 naming those versions; `delayMs`
 * holds every answer that long.
 */
export function fakeMcpServer({
	era = "dual",
	tools = [],
	tasks: withTasks = era !== "legacy",
}: {
	era?: McpEra;
	tools?: FakeTool[];
	/** Whether a 2026-07-28 server offers the Tasks extension. */
	tasks?: boolean;
} = {}) {
	const requests: {
		method?: string;
		params?: Record<string, unknown>;
		url: string;
		headers: Headers;
	}[] = [];
	const tasks = new Map<string, FakeTask>();
	const now = new Date().toISOString();
	const view = (taskId: string, task: FakeTask) => ({
		taskId,
		status: task.status,
		createdAt: now,
		lastUpdatedAt: now,
		ttlMs: null,
		...(task.pollIntervalMs === undefined
			? {}
			: { pollIntervalMs: task.pollIntervalMs }),
		...(task.status === "completed"
			? { result: { resultType: "complete", ...task.result } }
			: {}),
		...(task.status === "failed" ? { error: task.error } : {}),
		...(task.status === "input_required"
			? {
					inputRequests: {
						ask: {
							method: "elicitation/create",
							params: { message: "Which one?", requestedSchema: {} },
						},
					},
				}
			: {}),
	});
	const find = (params: unknown) => {
		const taskId = (params as { taskId: string }).taskId;
		const task = tasks.get(taskId);
		if (!task) throw new ProtocolError(-32602, `Unknown task: ${taskId}`);
		return { taskId, task };
	};

	const factory = ({ era }: { era: "legacy" | "modern" }) => {
		const server = new Server(
			{ name: "fake", version: "1" },
			{
				capabilities: {
					tools: {},
					...(withTasks && era === "modern"
						? { extensions: { [TASKS]: {} } }
						: {}),
				},
			},
		);
		server.setRequestHandler("tools/list", () => ({
			tools: tools.map(({ call: _, ...t }) => t),
		}));
		server.setRequestHandler("tools/call", async (request, ctx) => {
			const tool = tools.find((t) => t.name === request.params.name);
			if (!tool) throw new ProtocolError(-32602, "Unknown tool");
			const answer = (await tool.call?.(
				request.params.arguments ?? {},
				ctx.mcpReq.signal,
			)) ?? { content: [] };
			if ("inputRequired" in answer)
				// only the opaque state: the SDK refuses to ask a client for input it did not declare
				return { resultType: "input_required", requestState: "ask" } as never;
			if ("task" in answer) {
				const { task } = answer as { task: FakeTask };
				const taskId = `task-${tasks.size + 1}`;
				tasks.set(taskId, task);
				return { resultType: "task", ...view(taskId, task) } as never;
			}
			return answer;
		});
		if (withTasks && era === "modern") {
			const schemas = { params: anything, result: anything };
			server.setRequestHandler("tasks/get", schemas, (params: unknown) => {
				const { taskId, task } = find(params);
				return view(taskId, task);
			});
			server.setRequestHandler("tasks/cancel", schemas, (params: unknown) => {
				const { task } = find(params);
				if (!["completed", "failed", "cancelled"].includes(task.status))
					task.status = "cancelled";
				return {};
			});
		}
		return server;
	};
	const handler =
		era === "legacy"
			? legacyStatelessFallback(factory)
			: createMcpHandler(factory, {
					legacy: era === "dual" ? "stateless" : "reject",
				}).fetch;

	const state = {
		down: false,
		status: undefined as number | undefined,
		supported: undefined as string[] | undefined,
		/** How long each request takes to be answered. */
		delayMs: 0,
	};
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({
			method: body?.method,
			params: body?.params,
			url: String(input),
			headers: new Headers(init?.headers),
		});
		if (state.delayMs)
			await new Promise((resolve, reject) => {
				setTimeout(resolve, state.delayMs);
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		init?.signal?.throwIfAborted();
		if (state.down)
			throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
		if (state.status) return new Response("nope", { status: state.status });
		if (state.supported)
			return Response.json({
				jsonrpc: "2.0",
				id: body?.id ?? null,
				error: {
					code: -32022,
					message: "Unsupported protocol version",
					data: { supported: state.supported, requested: "2026-07-28" },
				},
			});
		return handler(new Request(String(input), init));
	};
	return Object.assign(state, { fetch, requests, tasks });
}
