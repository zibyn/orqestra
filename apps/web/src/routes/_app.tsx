import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "#/components/AppSidebar";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "#/components/ui/sidebar";
import { api, ok } from "#/lib/api";
import { signIn } from "#/lib/instance";
import { m } from "#/paraglide/messages";

// Signed-in two-column shell: Conversation sidebar on the left, the current view on the right
export const Route = createFileRoute("/_app")({
	beforeLoad: ({ context, location }) => {
		if (!context.user) throw signIn(location.href);
		return { user: context.user };
	},
	loader: async () => {
		const [conversations, tasks, agents, models] = await Promise.all([
			ok(api().api.conversations.get()),
			ok(api().api["scheduled-tasks"].get()),
			ok(api().api["agent-options"].get()),
			ok(api().api["model-options"].get()),
		]);
		return { conversations, tasks, agents, models };
	},
	component: AppLayout,
});

function AppLayout() {
	const { user } = Route.useRouteContext();
	const { conversations, tasks } = Route.useLoaderData();
	return (
		<SidebarProvider>
			<AppSidebar user={user} conversations={conversations} tasks={tasks} />
			<SidebarInset className="h-svh overflow-hidden md:h-[calc(100svh-1rem)]">
				<header className="flex h-12 shrink-0 items-center px-2">
					<SidebarTrigger aria-label={m.toggle_sidebar()} />
				</header>
				<Outlet />
			</SidebarInset>
		</SidebarProvider>
	);
}
