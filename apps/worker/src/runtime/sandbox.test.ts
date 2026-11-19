import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Turn } from "@orqestra/conversations";
import { memoryRun } from "@orqestra/conversations/testing";
import { memoryOrrery } from "@orqestra/integrations/testing";
import {
	finishConnection,
	type McpServer,
	startConnection,
} from "@orqestra/mcp";
import {
	fakeAuthorizationServer,
	memoryConnections,
} from "@orqestra/mcp/testing";
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
	// printenv as the Sandbox runs it, with the Exec's env and Secrets; git for real with that env, in a home of its own
	const o = memoryOrrery({
		exec: (command, _files, env) => {
			if (command.startsWith("printenv "))
				return { stdout: env[command.slice(9)] ?? "" };
			if (!command.startsWith("git ")) return {};
			const home = mkdtempSync(join(tmpdir(), "git-home-"));
			const r = spawnSync("bash", ["-c", command], {
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					GIT_CONFIG_NOSYSTEM: "1",
					...env,
				},
				encoding: "utf8",
			});
			rmSync(home, { recursive: true });
			return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
		},
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
	const bashOf = (run: typeof m.run, fetch = as.fetch) =>
		sandboxTools(run, [], {
			mcpServers: { [serverId]: server },
			fetch,
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
			GIT_CONFIG_VALUE_0: `!f(){ printf '%s\\n' username=x-access-token "password=$GH_TOKEN"; }; f`,
		});
		expect(request.stdin).toBeUndefined();
		expect(bash.description).toContain("/connections");
	});

	it("signs git in with the token as it is, read from the Secret's variable by the credential helper git runs", async () => {
		const { o, m, bashOf, stdout, stored } = await gitHost();
		const c = await stored();
		// a token the helper's shell would split and glob were its variable unquoted, and echo would read the backslashes of
		if (c?.tokens) c.tokens.access_token = "ghu_a  b *\\nc";

		expect(
			await stdout(
				bashOf(m.run),
				"git credential fill <<< $'protocol=https\\nhost=github.com\\n'",
			),
		).toBe(
			"protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghu_a  b *\\nc\n",
		);
		// the Exec's argv and env hold no token: the command reads it from GH_TOKEN, which orrery fills from the Secret
		expect(JSON.stringify(o.execs)).not.toContain("ghu_a");
		expect(o.execs[0].secrets).toEqual({ GH_TOKEN: [...o.secrets.keys()][0] });
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

	it("runs the command signed in to nothing once GitHub refuses the refresh token, even before the token it has expires, and the Connection needs reconnecting", async () => {
		const { as, o, m, bashOf, output, stored, expireIn, puts } =
			await gitHost();
		await expireIn(5 * 60_000);
		// used or expired: GitHub answers bad_refresh_token, with HTTP 200
		as.refreshTokens.clear();
		expect(await output(bashOf(m.run), "true")).toContain("Exit code: 0");
		expect((await stored())?.status).toBe("needs_reconnect");
		// signed in to nothing: no env and no Secret, only the time limit
		expect(o.execs.at(-1)).toEqual({
			argv: ["bash", "-lc", "true"],
			timeout: 600,
		});
		expect(puts()).toHaveLength(0);
	});

	for (const [failure, fail] of [
		["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
		["answering 502", async () => new Response("Bad Gateway", { status: 502 })],
	] as const)
		it(`runs the command on the token it has while its authorization server is ${failure}, until that token expires`, async () => {
			const { as, o, m, bashOf, stdout, stored, expireIn } = await gitHost();
			const bash = bashOf(m.run, (input, init) =>
				new URL(input).pathname === "/token" ? fail() : as.fetch(input, init),
			);
			const { access_token, refresh_token } = (await stored())?.tokens ?? {};
			await expireIn(5 * 60_000);
			const errors = spyOn(console, "error").mockImplementation(() => {});
			try {
				expect(await stdout(bash, "printenv GH_TOKEN")).toBe(access_token);
				expect(errors).toHaveBeenCalled();
				const logged = Bun.inspect(errors.mock.calls);
				for (const t of [access_token, refresh_token])
					expect(logged).not.toContain(t ?? "");

				await expireIn(-1);
				await stdout(bash, "true");
				// signed in to nothing: no env and no Secret, only the time limit
				expect(o.execs.at(-1)).toEqual({
					argv: ["bash", "-lc", "true"],
					timeout: 600,
				});
			} finally {
				errors.mockRestore();
			}
			expect(as.refreshed).toBe(0);
			// refreshing again may work: nothing refused it
			expect((await stored())?.status).toBe("connected");
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

describe("bash's time limit", () => {
	const bashIn = (o: ReturnType<typeof memoryOrrery>) =>
		sandboxTools(
			memoryRun({
				transcript: { messages: [] },
				turn: {} as Turn,
				orrery: o.client,
			}).run,
			[],
			{ mcpServers: {} },
		).find((t) => t.name === "bash") as AgentTool;
	const text = (r: Awaited<ReturnType<AgentTool["execute"]>>) =>
		r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

	it("stops a command after 10 minutes unless the Agent names a longer timeout, up to an hour", async () => {
		const o = memoryOrrery();
		const bash = bashIn(o);
		await bash.execute("1", { command: "ls" });
		await bash.execute("2", { command: "make", timeout: 3600 });
		expect(o.execs.map((e) => e.timeout)).toEqual([600, 3600]);
		expect(
			(bash.parameters as { properties: { timeout: { maximum: number } } })
				.properties.timeout.maximum,
		).toBe(3600);
	});

	it("tells the Agent a command ran out of time, with what it printed until then", async () => {
		const o = memoryOrrery({
			exec: () => ({ cause: "timed_out", stdout: "loaded 40000 rows\n" }),
		});
		const out = text(await bashIn(o).execute("1", { command: "load" }));
		expect(out).toContain("stopped after 600 seconds");
		expect(out).toContain("loaded 40000 rows");
	});
});
