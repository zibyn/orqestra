import { fakeMcpServer } from "@orqestra/mcp/testing";
import { memoryStore } from "@orqestra/tools/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { eq, sql } = await import("drizzle-orm");
const { createConfig } = await import("@orqestra/config/live");
const { createConversations } = await import("./index.ts");
const config = createConfig(db);

const general = {
	name: "General",
	description: "d",
	instructions: "",
	default: true,
};
const other = { name: "Other", description: "d", instructions: "" };
// nothing listens there, so the connection test fails fast; a fake answers deleting's requests
const serverUrl = "http://127.0.0.1:9/mcp";
const mcp = (id: string) => ({
	id,
	create: true,
	name: id,
	url: serverUrl,
	enabled: true,
	headers: [],
});

describe.skipIf(!url)("Deleting an MCP Server (Postgres)", () => {
	let fake: ReturnType<typeof fakeMcpServer>;
	/** What deleting did, in order. */
	let steps: string[];
	const conversations = createConversations({
		store: memoryStore().store,
		config: config.current,
		skillFiles: async () => [],
		fetch: (input, init) => {
			if (String(init?.body).includes('"tasks/cancel"')) steps.push("cancel");
			return fake.fetch(input, init);
		},
		mcpServers: {
			write: async (fn) => {
				const done = await config.write(fn);
				steps.push("delete");
				return done;
			},
		},
		agents: {
			forget: async (ref) => {
				await config.agents.forget(ref);
				steps.push("forget");
			},
		},
	});
	const reset = async () => {
		await db.execute(sql`truncate mcp_server, agent, conversation cascade`);
		await config.agents.save({
			id: "general",
			create: true,
			definition: general,
		});
	};
	beforeEach(async () => {
		fake = fakeMcpServer({ era: "modern" });
		steps = [];
		await reset();
	});
	afterAll(async () => {
		await reset();
		await config.close();
		await db.$client.end();
	});

	it("is removed from every Agent Definition when deleted", async () => {
		await config.mcpServers.save(mcp("docs"));
		await config.mcpServers.save(mcp("files"));
		const tools = ["search", "mcp:docs", "mcp:files"];
		await config.agents.save({
			id: "general",
			create: false,
			definition: { ...general, tools },
		});
		await config.agents.save({
			id: "other",
			create: true,
			definition: { ...other, tools: ["mcp:docs"] },
		});
		await conversations.deleteMcpServer("docs");
		const { agents, mcpServers } = await config.agents.list();
		expect(agents.map((a) => [a.id, a.definition.tools])).toEqual([
			["general", ["search", "mcp:files"]],
			["other", []],
		]);
		expect(mcpServers).toEqual([{ id: "files", name: "files" }]);
	});

	it("cancels its Background Calls first, while it can still be asked, then deletes it, then forgets it", async () => {
		await config.mcpServers.save(mcp("docs"));
		const [conv] = await db
			.insert(schema.conversation)
			.values({ userId: "a1" })
			.returning();
		const [said] = await db
			.insert(schema.message)
			.values({
				conversationId: conv.id,
				message: { role: "user", content: "crunch", timestamp: 0 },
				model: "faux/faux-1",
				thinkingLevel: "off",
			})
			.returning();
		await db.insert(schema.backgroundCall).values({
			conversationId: conv.id,
			toolCallId: "t1",
			mcpServerId: "docs",
			toolName: "crunch",
			reference: {
				endpointId: serverUrl,
				generation: "v2",
				taskId: "task-1",
				originalOperation: "tools/call",
			},
			jobId: "j1",
			messageId: said.id,
		});
		await conversations.deleteMcpServer("docs");
		expect(steps).toEqual(["cancel", "delete", "forget"]);
		const [ended] = await db
			.select({ status: schema.backgroundCall.status })
			.from(schema.backgroundCall)
			.where(eq(schema.backgroundCall.conversationId, conv.id));
		expect(ended.status).toBe("failed");
	});
});
