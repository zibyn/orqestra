import {
	Link,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import {
	ChevronsUpDownIcon,
	LogOutIcon,
	MoreHorizontalIcon,
	PencilIcon,
	SettingsIcon,
	SquarePenIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
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
	SidebarInput,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";
import { signOut } from "#/lib/auth-client";
import { deleteConversation, renameConversation } from "#/lib/conversation-fns";
import { displayName, isAdmin } from "#/lib/identity";
import { m } from "#/paraglide/messages";

export function AppSidebar({
	user,
	conversations,
}: {
	user: { email: string; phoneNumber?: string | null; role?: string | null };
	conversations: { id: string; title: string | null }[];
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
						{conversations.map((c) => (
							<ConversationItem key={c.id} conversation={c} />
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

function ConversationItem({
	conversation,
}: {
	conversation: { id: string; title: string | null };
}) {
	const router = useRouter();
	const navigate = useNavigate();
	const params = useParams({ strict: false });
	const active = params.conversationId === conversation.id;
	const [editing, setEditing] = useState(false);
	const title = conversation.title ?? m.untitled_conversation();

	const rename = async (value: string) => {
		setEditing(false);
		if (!value.trim() || value === title) return;
		await renameConversation({ data: { id: conversation.id, title: value } });
		await router.invalidate();
	};

	if (editing)
		return (
			<SidebarMenuItem>
				<SidebarInput
					autoFocus
					aria-label={m.rename()}
					defaultValue={title}
					onBlur={(e) => void rename(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") setEditing(false);
					}}
				/>
			</SidebarMenuItem>
		);

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				isActive={active}
				render={
					<Link
						to="/c/$conversationId"
						params={{ conversationId: conversation.id }}
					/>
				}
			>
				<span>{title}</span>
			</SidebarMenuButton>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<SidebarMenuAction showOnHover aria-label={m.more()} />}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="right" align="start">
					<DropdownMenuItem onClick={() => setEditing(true)}>
						<PencilIcon />
						{m.rename()}
					</DropdownMenuItem>
					<DropdownMenuItem
						variant="destructive"
						onClick={async () => {
							// shortcut: native confirm until the app has an AlertDialog component
							if (!window.confirm(m.delete_confirm())) return;
							await deleteConversation({ data: conversation.id });
							if (active) await navigate({ to: "/" });
							await router.invalidate();
						}}
					>
						<Trash2Icon />
						{m.delete()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}
