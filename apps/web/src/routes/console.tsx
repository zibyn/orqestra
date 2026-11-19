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
	ChartColumnIcon,
	ContainerIcon,
	FileTextIcon,
	GaugeIcon,
	type LucideIcon,
	MessagesSquareIcon,
	PlugIcon,
	SearchIcon,
	SettingsIcon,
	SquareKanbanIcon,
	UsersIcon,
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
import { api, ok } from "#/lib/api";
import { signIn } from "#/lib/instance";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console")({
	beforeLoad: ({ context, location }) => {
		if (!context.user) throw signIn(location.href);
		if (!context.user.admin) throw redirect({ to: "/" });
		return { user: context.user };
	},
	// the Integrations whose apps install by credentials each have a page of their own
	loader: () => ok(api().api.integrations.get()),
	component: Console,
});

type NavItem = {
	to:
		| "/console/providers"
		| "/console/agents"
		| "/console/search"
		| "/console/mcp"
		| "/console/skills"
		| "/console/sandbox"
		| "/console/parse"
		| "/console/linear"
		| "/console/limits"
		| "/console/users"
		| "/console/usage";
	label: () => string;
	icon: LucideIcon;
};

/** An Integration installed by credentials, at /console/$kind. */
type KindItem = { kind: string; label: () => string; icon: LucideIcon };

const href = (item: NavItem | KindItem) =>
	"kind" in item ? `/console/${item.kind}` : item.to;

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
			{ to: "/console/parse", label: m.document_parser, icon: FileTextIcon },
		],
	},
	{
		label: m.integrations,
		items: [{ to: "/console/linear", label: m.linear, icon: SquareKanbanIcon }],
	},
	{
		label: m.limits,
		items: [{ to: "/console/limits", label: m.limits, icon: GaugeIcon }],
	},
	{
		label: m.users,
		items: [
			{ to: "/console/users", label: m.users, icon: UsersIcon },
			{ to: "/console/usage", label: m.console_usage, icon: ChartColumnIcon },
		],
	},
];

function Console() {
	const { user } = Route.useRouteContext();
	const { pathname } = useLocation();
	const integrations = Route.useLoaderData();
	const groups = nav.map((group) =>
		group.label !== m.integrations
			? group
			: {
					...group,
					items: [
						...group.items,
						...integrations
							.filter((i) => i.install === "credentials")
							.map(
								(i): KindItem => ({
									kind: i.kind,
									label: () => i.name,
									icon: MessagesSquareIcon,
								}),
							),
					],
				},
	);
	const current = groups
		.flatMap((g) => g.items)
		.find((item) => pathname.startsWith(href(item)));

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
					{groups.map((group) => (
						<SidebarGroup key={href(group.items[0])}>
							<SidebarGroupLabel>{group.label()}</SidebarGroupLabel>
							<SidebarMenu>
								{group.items.map((item) => (
									<SidebarMenuItem key={href(item)}>
										<SidebarMenuButton
											isActive={item === current}
											tooltip={item.label()}
											render={
												"kind" in item ? (
													<Link
														to="/console/$kind"
														params={{ kind: item.kind }}
													/>
												) : (
													<Link to={item.to} />
												)
											}
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
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
					<SidebarTrigger className="-ml-1" aria-label={m.toggle_sidebar()} />
					<Separator
						orientation="vertical"
						className="mr-2 data-vertical:h-4 data-vertical:self-center"
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
				<div className="flex flex-1 flex-col px-4 py-6 md:px-10 md:py-10">
					<Outlet />
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
