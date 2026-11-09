import {
	createFileRoute,
	getRouteApi,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Composer } from "#/components/Composer";
import { Switch } from "#/components/ui/switch";
import { sendMessage, startConversation } from "#/lib/conversation-fns";
import { uploadFiles } from "#/lib/uploads";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/")({ component: NewConversation });

const app = getRouteApi("/_app");

function NewConversation() {
	const agents = app.useLoaderData().agents.filter((a) => a.pickable);
	const { user } = app.useRouteContext();
	const [agentId, setAgentId] = useState(
		() => (agents.find((a) => a.default) ?? agents[0])?.id,
	);
	const [incognito, setIncognito] = useState(false);
	const started = useRef<{ agentId: string; incognito: boolean; id: string }>(
		undefined,
	);
	const navigate = useNavigate();
	const router = useRouter();

	return (
		// the greeting and the Composer are one block, centred a little above the middle
		<div className="flex min-h-0 flex-1 flex-col justify-center pb-[12svh]">
			<div className="flex flex-col items-center gap-3 px-4 pb-8 text-center">
				<h1 className="text-3xl font-semibold sm:text-4xl">
					{m.empty_title()}
				</h1>
				{!agentId && (
					<p className="text-sm text-muted-foreground">
						{user.admin ? (
							<Link to="/console/providers" className="text-link underline">
								{m.no_models_admin()}
							</Link>
						) : (
							m.no_models_member()
						)}
					</p>
				)}
				{agentId && (
					// chosen here only: a started Conversation keeps it
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Switch
							id="incognito"
							checked={incognito}
							onCheckedChange={setIncognito}
						/>
						<label htmlFor="incognito">
							{m.incognito()}
							{incognito && ` · ${m.incognito_hint()}`}
						</label>
					</div>
				)}
			</div>
			{agentId && (
				<Composer
					agents={agents}
					agentId={agentId}
					onAgentChange={setAgentId}
					running={false}
					onStop={() => {}}
					onSend={async ({ files, ...input }) => {
						// attachments go into the Sandbox of a Conversation started for them; a failed upload reuses it
						let conversationId =
							started.current?.agentId === agentId &&
							started.current.incognito === incognito
								? started.current.id
								: undefined;
						if (files.length && !conversationId) {
							conversationId = await startConversation({
								data: { agentId, incognito },
							});
							started.current = { agentId, incognito, id: conversationId };
						}
						const attachments = conversationId
							? await uploadFiles(conversationId, files)
							: [];
						const id = await sendMessage({
							data: {
								...input,
								agentId,
								conversationId,
								attachments,
								incognito,
							},
						});
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
