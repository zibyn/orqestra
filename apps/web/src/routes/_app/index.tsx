import {
	createFileRoute,
	getRouteApi,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import { Composer } from "#/components/Composer";
import { sendMessage } from "#/lib/conversation-fns";
import { isAdmin } from "#/lib/identity";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/")({ component: NewConversation });

const app = getRouteApi("/_app");

function NewConversation() {
	const agents = app.useLoaderData().agents.filter((a) => a.pickable);
	const { user } = app.useRouteContext();
	const [agentId, setAgentId] = useState(
		() => (agents.find((a) => a.default) ?? agents[0])?.id,
	);
	const navigate = useNavigate();
	const router = useRouter();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
				<MessageSquareIcon className="size-8 text-muted-foreground" />
				<h1 className="text-lg font-medium">{m.empty_title()}</h1>
				<p className="text-sm text-muted-foreground">
					{!agentId ? (
						isAdmin(user) ? (
							<Link to="/console/providers" className="text-link underline">
								{m.no_models_admin()}
							</Link>
						) : (
							m.no_models_member()
						)
					) : (
						m.empty_hint()
					)}
				</p>
			</div>
			{agentId && (
				<Composer
					agents={agents}
					agentId={agentId}
					onAgentChange={setAgentId}
					running={false}
					onStop={() => {}}
					onSend={async (input) => {
						const id = await sendMessage({ data: { ...input, agentId } });
						await router.invalidate();
						await navigate({
							to: "/c/$conversationId",
							params: { conversationId: id },
						});
					}}
				/>
			)}
		</div>
	);
}
