import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Turn } from "@orqestra/conversations";
import { memoryRun } from "@orqestra/conversations/testing";
import {
	finishConnection,
	type McpServer,
	startConnection,
} from "@orqestra/mcp";
import {
	fakeAuthorizationServer,
	memoryConnections,
} from "@orqestra/mcp/testing";
import { memoryOrrery } from "@orqestra/tools/testing";
import { sandboxTools } from "./sandbox.ts";

// bash in a Sandbox kept in memory, signed in to a Git Host whose authorization server answers as GitHub's does for a GitHub App
let servers = 0;
async function gitHost() {
	// its own id per test: the Secrets this process wrote are remembered across Runs
	const serverId = `github-${++servers}`;
	const as = fakeAuthorizationServer({
		resource: "https://api.githubcopilot.example/mcp/",
		issuer: "https://github.example",
	});
	Object.assign(as, { github: true, registration: false, expiresIn: 28800 });
	const server: McpServer = {
		name: "GitHub",
		url: as.resource,
		auth: "oauth",
		oauthClient: { client_id: "Iv1.app", client_secret: "app-secret" },
		headers: {},
		git: {
			host: "github.com",
			username: "x-access-token",
			tokenEnv: "GH_TOKEN",
		},
	};
	const connections = memoryConnections();
	// printenv as the Sandbox runs it, with the Exec's env and Secrets
	const o = memoryOrrery({
		exec: (command, _files, env) =>
			command.startsWith("printenv ")
				? { stdout: env[command.slice(9)] ?? "" }
				: {},
	});
	const newRun = () =>
		memoryRun({
			transcript: { messages: [] },
			turn: {} as Turn,
			orrery: o.client,
			connections,
		});
	const m = newRun();
	const userId = m.run.userId;
	const bashOf = (run: typeof m.run) =>
		sandboxTools(run, [], {
			mcpServers: { [serverId]: server },
			fetch: as.fetch,
		}).find((t) => t.name === "bash") as AgentTool;
	const output = async (bash: AgentTool, command: string) => {
		const result = await bash.execute("1", { command });
		return result.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("");
	};
	const stdout = async (bash: AgentTool, command: string) =>
		/<stdout>\n(.*)\n<\/stdout>/s.exec(await output(bash, command))?.[1];
	const stored = async () => connections.connection(userId, serverId);
	/** The access token now expires within `ms`. */
	const expireIn = async (ms: number) => {
		const c = await stored();
		if (c?.tokens) c.tokens.expires_at = Date.now() + ms;
	};
	// the User connects on /connections
	const context = {
		userId,
		serverId,
		server,
		store: connections,
		orqestraUrl: "http://localhost:3000",
		fetch: as.fetch,
	};
	const started = await startConnection(context);
	if (!("url" in started)) throw new Error(started.detail);
	await finishConnection(
		{ ...context, server: async () => server },
		as.authorize(started.url),
	);
	const puts = () => o.calls.filter((c) => c.startsWith("putSecret"));
	return { as, o, m, newRun, bashOf, output, stdout, stored, expireIn, puts };
}

describe("bash signed in to a Git Host", () => {
	it("gives the command the User's token through an orrery Secret only, with a credential helper reading it", async () => {
		const { o, m, bashOf, stdout, stored } = await gitHost();
		const bash = bashOf(m.run);
		const token = (await stored())?.tokens?.access_token ?? "";
		expect(token).toStartWith("ghu_");

		expect(await stdout(bash, "printenv GH_TOKEN")).toBe(token);
		expect([...o.secrets.values()]).toEqual([token]);
		const [request] = o.execs;
		// nothing orrery stores of the Exec, its argv, env or stdin, holds the token
		expect(JSON.stringify(o.execs)).not.toContain("ghu_");
		const [secret] = o.secrets.keys();
		expect(secret).toMatch(/^orq-git-[0-9a-f]{16}$/);
		expect(request.secrets).toEqual({ GH_TOKEN: secret });
		expect(request.env).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
			GIT_CONFIG_VALUE_0:
				"!f(){ echo username=x-access-token; echo password=$GH_TOKEN; }; f",
		});
		expect(request.stdin).toBeUndefined();
		expect(bash.description).toContain("/connections");
	});

	it("writes the Secret once while the token stays the same", async () => {
		const { m, bashOf, output, puts } = await gitHost();
		const bash = bashOf(m.run);
		await output(bash, "true");
		await output(bash, "true");
		expect(puts()).toHaveLength(1);
	});

	it("refreshes a token that would expire during the command first, then writes the new one", async () => {
		const { as, o, m, bashOf, stdout, stored, expireIn, puts } =
			await gitHost();
		const bash = bashOf(m.run);
		await stdout(bash, "true");
		const old = (await stored())?.tokens?.access_token;
		await expireIn(5 * 60_000);

		const sent = await stdout(bash, "printenv GH_TOKEN");
		expect(as.refreshed).toBe(1);
		const fresh = (await stored())?.tokens?.access_token;
		expect(fresh).not.toBe(old);
		expect(sent).toBe(fresh);
		expect(as.accessTokens.has(sent ?? "")).toBe(true);
		expect(puts()).toHaveLength(2);
		expect(JSON.stringify(o.execs)).not.toContain("ghu_");
	});

	it("refreshes once when two Runs need it at once: GitHub's refresh token works once", async () => {
		const { as, m, newRun, bashOf, stdout, stored, expireIn } = await gitHost();
		await expireIn(-1);
		const [a, b] = await Promise.all([
			stdout(bashOf(m.run), "printenv GH_TOKEN"),
			stdout(bashOf(newRun().run), "printenv GH_TOKEN"),
		]);
		expect(as.refreshed).toBe(1);
		const saved = await stored();
		expect(saved?.status).toBe("connected");
		expect([a, b]).toEqual([
			saved?.tokens?.access_token,
			saved?.tokens?.access_token,
		]);
	});

	it("runs the command signed in to nothing once GitHub refuses the refresh token, and the Connection needs reconnecting", async () => {
		const { as, o, m, bashOf, output, stored, expireIn, puts } =
			await gitHost();
		await expireIn(-1);
		// used or expired: GitHub answers bad_refresh_token, with HTTP 200
		as.refreshTokens.clear();
		expect(await output(bashOf(m.run), "true")).toContain("Exit code: 0");
		expect((await stored())?.status).toBe("needs_reconnect");
		expect(o.execs.at(-1)).toEqual({ argv: ["bash", "-lc", "true"] });
		expect(puts()).toHaveLength(0);
	});

	it("writes the Secret again when orrery no longer has it, and the command runs", async () => {
		const { o, m, bashOf, stdout, stored, puts } = await gitHost();
		const bash = bashOf(m.run);
		await stdout(bash, "true");
		// another Sandbox Provider, or the Secret was deleted
		o.secrets.clear();
		expect(await stdout(bash, "printenv GH_TOKEN")).toBe(
			(await stored())?.tokens?.access_token,
		);
		expect(puts()).toHaveLength(2);
	});
});
