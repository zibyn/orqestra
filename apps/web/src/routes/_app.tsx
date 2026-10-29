import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "#/components/AppSidebar";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "#/components/ui/sidebar";
import { getAgentOptions, listConversations } from "#/lib/conversation-fns";
import { m } from "#/paraglide/messages";

// Signed-in two-column shell: Conversation sidebar on the left, the current view on the right
export const Route = createFileRoute("/_app")({
	beforeLoad: ({ context }) => {
		if (!context.user) throw redirect({ to: "/login" });
		return { user: context.user };
	},
	loader: async () => {
		const [conversations, agents] = await Promise.all([
			listConversations(),
			getAgentOptions(),
		]);
		return { conversations, agents };
	},
	component: AppLayout,
});

function AppLayout() {
	const { user } = Route.useRouteContext();
	const { conversations } = Route.useLoaderData();
	return (
		<SidebarProvider>
			<AppSidebar user={user} conversations={conversations} />
			<SidebarInset className="h-svh">
				<header className="flex h-12 shrink-0 items-center px-2">
					<SidebarTrigger aria-label={m.toggle_sidebar()} />
				</header>
				<Outlet />
			</SidebarInset>
		</SidebarProvider>
	);
}
