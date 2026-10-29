import { createFileRoute } from "@tanstack/react-router";
import { listAgents } from "#/lib/agents";

export const Route = createFileRoute("/console/agents")({
	loader: () => listAgents(),
	component: Agents,
});

function Agents() {
	const { agents, providers } = Route.useLoaderData();

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">Agents</h1>
			<p className="text-sm text-muted-foreground">
				Read from the config directory. Edit the files and restart to change
				them.
			</p>
			<ul className="flex flex-col gap-4">
				{agents.map((agent) => (
					<li key={agent.id} className="text-sm">
						<h2 className="font-medium">
							{agent.name}{" "}
							<code className="text-muted-foreground">{agent.id}</code>
							{agent.default && " (default)"}
						</h2>
						<p className="text-muted-foreground">{agent.description}</p>
						<p>
							Models:{" "}
							{agent.models.map((m, i) => (
								<span key={m}>
									{i > 0 && ", "}
									<code>{m}</code>
									{m === agent.defaultModel && " (default)"}
								</span>
							))}
						</p>
					</li>
				))}
			</ul>
			<div className="text-sm">
				<h2 className="mb-1 font-medium">Providers</h2>
				<ul>
					{providers.map((p) => (
						<li key={p.id}>
							{p.name} <code>{p.id}</code>:{" "}
							{p.keyConfigured ? "API key configured" : "API key not set"}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
