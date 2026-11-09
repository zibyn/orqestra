import type { User } from "@orqestra/api";
import {
	Link,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import {
	EyeOffIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PencilIcon,
	SquarePenIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { NavUser } from "#/components/NavUser";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
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
import { api, ok } from "#/lib/api";
import { m } from "#/paraglide/messages";

export function AppSidebar({
	user,
	conversations,
}: {
	user: User;
	conversations: {
		id: string;
		title: string | null;
		background: boolean;
		incognito: boolean;
	}[];
}) {
	return (
		<Sidebar variant="inset">
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
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}

function ConversationItem({
	conversation,
}: {
	conversation: {
		id: string;
		title: string | null;
		background: boolean;
		incognito: boolean;
	};
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
		await ok(
			api().api.conversations({ id: conversation.id }).patch({ title: value }),
		);
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
				{conversation.incognito && (
					<EyeOffIcon
						role="img"
						aria-label={m.incognito()}
						className="text-muted-foreground"
					/>
				)}
				<span>{title}</span>
				{conversation.background && (
					<Loader2Icon
						aria-label={m.background_subagents()}
						className="ml-auto animate-spin text-signal"
					/>
				)}
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
							await ok(
								api().api.conversations({ id: conversation.id }).delete(),
							);
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
