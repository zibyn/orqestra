import handler from "@tanstack/react-start/server-entry";
import { paraglideMiddleware } from "./paraglide/server";

// Resolves the locale cookie per request so SSR renders the same language as the client
export default {
	fetch(req: Request) {
		return paraglideMiddleware(req, () => handler.fetch(req));
	},
};
