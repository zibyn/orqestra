import { createFileRoute } from "@tanstack/react-router";
import { listAgents } from "#/lib/agents";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/agents")({
	loader: () => listAgents(),
	component: Agents,
});

const code = "rounded bg-muted px-1 py-0.5 font-mono";

function Agents() {
	const { agents, providers } = Route.useLoaderData();

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-xl font-semibold">{m.console_agents()}</h1>
			<p className="text-sm text-muted-foreground">{m.agents_hint()}</p>
			{agents.map((agent) => (
				<div key={agent.id} className="rounded-lg border p-4 text-sm">
					<h2 className="mb-1 font-medium">
						{agent.name} <code className={code}>{agent.id}</code>
						{agent.default && ` (${m.default_marker()})`}
					</h2>
					<p className="text-muted-foreground">{agent.description}</p>
					<p className="mt-2">
						{m.agent_models()}:{" "}
						{agent.models.map((model, i) => (
							<span key={model}>
								{i > 0 && ", "}
								<code className={code}>{model}</code>
								{model === agent.defaultModel && ` (${m.default_marker()})`}
							</span>
						))}
					</p>
				</div>
			))}
			<div className="rounded-lg border p-4 text-sm">
				<h2 className="mb-1 font-medium">{m.providers()}</h2>
				<ul>
					{providers.map((p) => (
						<li key={p.id}>
							{p.name} <code className={code}>{p.id}</code>:{" "}
							{p.keyConfigured
								? m.provider_key_configured()
								: m.provider_key_missing()}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
