import { Link } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import ParaglideLocaleSwitcher from "#/components/LocaleSwitcher";
import { ThemeSwitcher } from "#/components/ThemeSwitcher";
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
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";
import type { User } from "#/lib/identity";
import { m } from "#/paraglide/messages";

// The SDK's logout is POST only, so another site cannot sign the User out with a link
function signOut() {
	const form = document.createElement("form");
	form.method = "post";
	form.action = "/auth/logout";
	document.body.append(form);
	form.submit();
}

/** The user menu at the foot of a sidebar: theme, language, /console for Admins, sign out. */
export function NavUser({ user }: { user: User }) {
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<SidebarMenuButton size="lg" tooltip={user.name} />}
					>
						<span
							aria-hidden
							className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-xs font-medium uppercase"
						>
							{user.name.slice(0, 1)}
						</span>
						<span className="flex-1 truncate">{user.name}</span>
						<ChevronsUpDownIcon className="ml-auto" />
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" className="min-w-56">
						<DropdownMenuGroup>
							<DropdownMenuLabel className="truncate">
								{user.name}
							</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<ThemeSwitcher />
						<ParaglideLocaleSwitcher />
						{user.admin && (
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
	);
}
