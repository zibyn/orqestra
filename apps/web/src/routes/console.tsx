import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useLocation,
} from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	BookOpenIcon,
	BotIcon,
	BoxesIcon,
	ContainerIcon,
	type LucideIcon,
	PlugIcon,
	SearchIcon,
	SettingsIcon,
} from "lucide-react";
import { NavUser } from "#/components/NavUser";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Separator } from "#/components/ui/separator";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "#/components/ui/sidebar";
import { signIn } from "#/lib/instance";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console")({
	beforeLoad: ({ context, location }) => {
		if (!context.user) throw signIn(location.href);
		if (!context.user.admin) throw redirect({ to: "/" });
		return { user: context.user };
	},
	component: Console,
});

type NavItem = {
	to:
		| "/console/providers"
		| "/console/agents"
		| "/console/search"
		| "/console/mcp"
		| "/console/skills"
		| "/console/sandbox";
	label: () => string;
	icon: LucideIcon;
};

// One list drives the sidebar and the breadcrumb; labels are functions so they follow the locale
const nav: { label: () => string; items: NavItem[] }[] = [
	{
		label: m.models,
		items: [
			{ to: "/console/providers", label: m.providers, icon: BoxesIcon },
			{ to: "/console/agents", label: m.console_agents, icon: BotIcon },
			{ to: "/console/skills", label: m.skills, icon: BookOpenIcon },
		],
	},
	{
		label: m.tools,
		items: [
			{ to: "/console/search", label: m.search_providers, icon: SearchIcon },
			{ to: "/console/mcp", label: m.mcp_servers, icon: PlugIcon },
			{
				to: "/console/sandbox",
				label: m.sandbox_provider,
				icon: ContainerIcon,
			},
		],
	},
];

function Console() {
	const { user } = Route.useRouteContext();
	const { pathname } = useLocation();
	const current = nav
		.flatMap((g) => g.items)
		.find((item) => pathname.startsWith(item.to));

	return (
		<SidebarProvider>
			<Sidebar collapsible="icon" variant="inset">
				<SidebarHeader>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size="lg" render={<Link to="/console" />}>
								<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
									<SettingsIcon />
								</span>
								<span className="flex flex-col leading-tight">
									<span className="truncate font-medium">Orqestra</span>
									<span className="truncate text-xs text-muted-foreground">
										{m.console()}
									</span>
								</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent>
					{nav.map((group) => (
						<SidebarGroup key={group.items[0].to}>
							<SidebarGroupLabel>{group.label()}</SidebarGroupLabel>
							<SidebarMenu>
								{group.items.map((item) => (
									<SidebarMenuItem key={item.to}>
										<SidebarMenuButton
											isActive={item === current}
											tooltip={item.label()}
											render={<Link to={item.to} />}
										>
											<item.icon />
											<span>{item.label()}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroup>
					))}
					<SidebarGroup className="mt-auto">
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									tooltip={m.back_to_conversations()}
									render={<Link to="/" />}
								>
									<ArrowLeftIcon />
									<span>{m.back_to_conversations()}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<NavUser user={user} />
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>
			<SidebarInset>
				<header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" aria-label={m.toggle_sidebar()} />
					<Separator
						orientation="vertical"
						className="mr-2 data-[orientation=vertical]:h-4"
					/>
					<Breadcrumb>
						<BreadcrumbList>
							<BreadcrumbItem className="hidden md:block">
								<BreadcrumbLink render={<Link to="/console" />}>
									{m.console()}
								</BreadcrumbLink>
							</BreadcrumbItem>
							{current && (
								<>
									<BreadcrumbSeparator className="hidden md:block" />
									<BreadcrumbItem>
										<BreadcrumbPage>{current.label()}</BreadcrumbPage>
									</BreadcrumbItem>
								</>
							)}
						</BreadcrumbList>
					</Breadcrumb>
				</header>
				<div className="flex flex-1 flex-col p-4 md:p-8">
					<Outlet />
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
