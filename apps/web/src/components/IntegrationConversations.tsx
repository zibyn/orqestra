import { useRouter } from "@tanstack/react-router";
import { CheckCircle2Icon, CopyIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

/** A read-only value the Admin copies into the Integration's settings. */
export function CopyField({
	id,
	label,
	value,
	hint,
}: {
	id: string;
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="flex gap-2">
				<Input id={id} readOnly className="font-mono" value={value} />
				<Button
					type="button"
					size="icon"
					variant="outline"
					aria-label={m.copy()}
					onClick={() => navigator.clipboard.writeText(value).catch(() => {})}
				>
					<CopyIcon />
				</Button>
			</div>
			{hint && <FieldDescription>{hint}</FieldDescription>}
		</Field>
	);
}

const lines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([key]) => key);

/**
 * The Agent of the Conversations an Integration opens, the repository each scope's work is done in, one `SCOPE owner/repo` a line,
 * and, for one whose group chats reach the Agent only once opened, the scopes opened, one a line.
 */
export function IntegrationConversations({
	kind,
	installation,
	agents,
	openScopes,
	texts,
}: {
	kind: string;
	installation: {
		defaultAgentId: string | null;
		scopeRepos: Record<string, string>;
		openScopes?: string[];
	};
	agents: { id: string; name: string; default: boolean; pickable: boolean }[];
	/** The scopes opened to shared sessions are asked for. */
	openScopes: boolean;
	texts: {
		hint: string;
		repos: string;
		reposHint: string;
		placeholder: string;
		saved: string;
	};
}) {
	const router = useRouter();
	const pickable = agents.filter((a) => a.pickable);
	const [agentId, setAgentId] = useState(
		installation.defaultAgentId ??
			(pickable.find((a) => a.default) ?? pickable[0])?.id ??
			"",
	);
	const [repos, setRepos] = useState(
		Object.entries(installation.scopeRepos)
			.map(([scope, repo]) => `${scope} ${repo}`)
			.join("\n"),
	);
	const [opened, setOpened] = useState(
		(installation.openScopes ?? []).join("\n"),
	);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function save() {
		setBusy(true);
		setDone(false);
		try {
			const result = await saved(
				api()
					.api({ kind })
					.conversations.put({
						defaultAgentId: agentId,
						scopeRepos: Object.fromEntries(
							lines(repos).map(([scope, repo = ""]) => [scope, repo]),
						),
						...(openScopes && {
							openScopes: lines(opened).map(([scope]) => scope),
						}),
					}),
			);
			setErrors(saveErrorTexts(result.errors));
			setDone(!Object.keys(result.errors).length);
			await router.invalidate();
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	// "scopeRepos.OPS": the scope whose line it refused
	const fieldErrors = (name: string) =>
		Object.entries(errors)
			.filter(([field]) => field.startsWith(name))
			.map(([field, text]) =>
				`${field.replace(name, "").replace(/^\./, "")} ${text}`.trim(),
			)
			.join("; ");
	const reposError = fieldErrors("scopeRepos");
	const openedError = fieldErrors("openScopes");

	return (
		<Card>
			<CardContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<FieldGroup className="gap-5">
						<FieldDescription>{texts.hint}</FieldDescription>
						<Picker
							label={m.linear_agent()}
							error={errors.defaultAgentId}
							value={agentId}
							onChange={setAgentId}
							items={pickable.map((a) => ({ value: a.id, label: a.name }))}
						/>
						<Field data-invalid={!!reposError || undefined}>
							<FieldLabel htmlFor={`${kind}-scope-repos`}>
								{texts.repos}
							</FieldLabel>
							<Textarea
								id={`${kind}-scope-repos`}
								className="font-mono"
								placeholder={texts.placeholder}
								aria-invalid={!!reposError || undefined}
								value={repos}
								onChange={(e) => setRepos(e.target.value)}
							/>
							<FieldDescription>{texts.reposHint}</FieldDescription>
							<FieldError>{reposError}</FieldError>
						</Field>
						{openScopes && (
							<Field data-invalid={!!openedError || undefined}>
								<FieldLabel htmlFor={`${kind}-open-scopes`}>
									{m.integration_open_scopes()}
								</FieldLabel>
								<Textarea
									id={`${kind}-open-scopes`}
									className="font-mono"
									aria-invalid={!!openedError || undefined}
									value={opened}
									onChange={(e) => setOpened(e.target.value)}
								/>
								<FieldDescription>
									{m.integration_open_scopes_hint()}
								</FieldDescription>
								<FieldError>{openedError}</FieldError>
							</Field>
						)}
						<Button type="submit" className="self-start" disabled={busy}>
							{busy && (
								<Loader2Icon
									data-icon="inline-start"
									className="animate-spin"
								/>
							)}
							{m.save()}
						</Button>
						{done && (
							<Alert>
								<CheckCircle2Icon />
								<AlertDescription>{texts.saved}</AlertDescription>
							</Alert>
						)}
						<FieldError>{errors[""]}</FieldError>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
