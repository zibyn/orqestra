import { createFileRoute, redirect } from "@tanstack/react-router";

// Users are managed in Polaris; the console opens on its first own tab
export const Route = createFileRoute("/console/")({
	beforeLoad: () => {
		throw redirect({ to: "/console/providers" });
	},
});
