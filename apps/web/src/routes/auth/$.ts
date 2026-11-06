import { createFileRoute } from "@tanstack/react-router";
import { polaris } from "#/lib/polaris";

// The Polaris SDK's /auth/login, /auth/callback, /auth/logout and /auth/session
export const Route = createFileRoute("/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => polaris.handler(request),
			POST: ({ request }) => polaris.handler(request),
		},
	},
});
