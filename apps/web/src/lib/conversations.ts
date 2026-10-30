import { config } from "@orqestra/config/live";
import { createConversations } from "@orqestra/conversations";

// Conversations of the signed-in user, for the server functions in conversation-fns.ts and the SSE route
export const conversations = createConversations({ config: config.current });
