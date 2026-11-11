import { createFileRoute, redirect } from "@tanstack/react-router";

// the console opens on its first tab
export const Route = createFileRoute("/console/")({
	beforeLoad: () => {
		throw redirect({ to: "/console/providers" });
	},
});
