import type { User } from "@orqestra/api";
import {
	Link,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarClockIcon,
	EyeOffIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PencilIcon,
	SquarePenIcon,
	Trash2Icon,
	XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import { NavUser } from "#/components/NavUser";
import { UnreadMark } from "#/components/UnreadMark";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
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
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "#/components/ui/sidebar";
import { api, ok } from "#/lib/api";
import type { Task } from "#/lib/tasks";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type Listed = NonNullable<
	Awaited<
		ReturnType<ReturnType<typeof api>["api"]["conversations"]["get"]>
	>["data"]
>[number];

export function AppSidebar({
	user,
	conversations,
	tasks,
}: {
	user: User;
	conversations: Listed[];
	tasks: Task[];
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
				{!!tasks.length && (
					<SidebarGroup>
						<SidebarGroupLabel>{m.tasks_page()}</SidebarGroupLabel>
						<SidebarMenu>
							{tasks.map((t) => (
								<TaskItem key={t.id} task={t} />
							))}
						</SidebarMenu>
					</SidebarGroup>
				)}
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

/** A Scheduled Task, folded open on its latest Firings' Conversations: bold while any of its Firings' is Unread, an error icon once it paused itself. */
function TaskItem({ task }: { task: Task }) {
	const params = useParams({ strict: false });
	return (
		<Collapsible defaultOpen render={<SidebarMenuItem />}>
			<CollapsibleTrigger render={<SidebarMenuButton />}>
				<CalendarClockIcon className="text-muted-foreground" />
				<span className={cn("truncate", task.unread && "font-medium")}>
					{task.name}
				</span>
				{task.state === "auto_paused" && (
					<XCircleIcon
						role="img"
						aria-label={m.task_state_auto_paused()}
						className="ml-auto text-destructive"
					/>
				)}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<SidebarMenuSub>
					{task.conversations.map((c) => (
						<SidebarMenuSubItem key={c.id}>
							<SidebarMenuSubButton
								isActive={params.conversationId === c.id}
								render={
									<Link
										to="/c/$conversationId"
										params={{ conversationId: c.id }}
									/>
								}
							>
								<span className={cn("truncate", c.unread && "font-medium")}>
									{c.title ??
										new Date(c.firedAt).toLocaleString(getLocale(), {
											dateStyle: "short",
											timeStyle: "short",
										})}
								</span>
								<UnreadMark unread={c.unread} awaitingReply={c.awaitingReply} />
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ConversationItem({ conversation }: { conversation: Listed }) {
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
				<span className={cn(conversation.unread && "font-medium")}>
					{title}
				</span>
				{conversation.background ? (
					<Loader2Icon
						aria-label={m.background_subagents()}
						className="ml-auto animate-spin text-signal"
					/>
				) : (
					<UnreadMark
						unread={conversation.unread}
						awaitingReply={conversation.awaitingReply}
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
