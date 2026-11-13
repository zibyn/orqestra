import type { Tools } from "@orqestra/tools/live";
import { documentParserInput } from "@orqestra/tools/live";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// The Document Parser (MinerU), edited by Admins in /console/parse. The key only goes in.
export const documentParser = (signedIn: SignedIn, tools: Tools) =>
	new Elysia({ prefix: "/document-parser" })
		.use(signedIn)
		.derive(adminOnly)
		// wrapped, as a bare null would be an empty body
		.get("/", async () => ({ parser: await tools.documentParser.get() }))
		// once saved, with the connection test's result
		.post(
			"/",
			async ({ body }) => saved(await tools.documentParser.save(body)),
			{ body: documentParserInput },
		)
		// Parse becomes unavailable
		.delete("/", async () => {
			await tools.documentParser.delete();
		});
