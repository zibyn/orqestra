import { config, skillFiles } from "@orqestra/config/live";
import { createConversations } from "@orqestra/conversations";

// Conversations of the signed-in user, for the SSE, uploads and files routes
export const conversations = createConversations({
	config: config.current,
	skillFiles,
});
