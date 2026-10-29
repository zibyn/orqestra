import { Link } from "@tanstack/react-router";
import {
	ChevronsUpDownIcon,
	LogOutIcon,
	SettingsIcon,
	SquarePenIcon,
} from "lucide-react";
import ParaglideLocaleSwitcher from "#/components/LocaleSwitcher";
import { ThemeSwitcher } from "#/components/ThemeSwitcher";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";
import { signOut } from "#/lib/auth-client";
import { displayName, isAdmin } from "#/lib/identity";
import { m } from "#/paraglide/messages";

// shortcut: placeholder Conversations until real data lands in #4
const placeholderConversations = [
	{ id: "1", title: "周报草稿" },
	{ id: "2", title: "Translate release notes" },
	{ id: "3", title: "SQL 查询优化" },
];

export function AppSidebar({
	user,
}: {
	user: { email: string; phoneNumber?: string | null; role?: string | null };
}) {
	return (
		<Sidebar>
			<SidebarHeader>
				<Button
					variant="secondary"
					className="w-full justify-start"
					nativeButton={false}
					render={<Link to="/" />}
				>
					<SquarePenIcon />
					{m.new_conversation()}
				</Button>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>{m.conversations()}</SidebarGroupLabel>
					<SidebarMenu>
						{placeholderConversations.map((c) => (
							<SidebarMenuItem key={c.id}>
								<SidebarMenuButton>
									<span>{c.title}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<DropdownMenu>
							<DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
								<span
									aria-hidden
									className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-xs font-medium uppercase"
								>
									{displayName(user).slice(0, 1)}
								</span>
								<span className="flex-1 truncate">{displayName(user)}</span>
								<ChevronsUpDownIcon className="ml-auto" />
							</DropdownMenuTrigger>
							<DropdownMenuContent side="top" className="min-w-56">
								<DropdownMenuGroup>
									<DropdownMenuLabel className="truncate">
										{displayName(user)}
									</DropdownMenuLabel>
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
								<ThemeSwitcher />
								<ParaglideLocaleSwitcher />
								{isAdmin(user) && (
									<DropdownMenuItem render={<Link to="/console" />}>
										<SettingsIcon />
										{m.console()}
									</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={signOut}>
									<LogOutIcon />
									{m.sign_out()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
