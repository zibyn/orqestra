import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckCircle2Icon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
	deleteSandboxProvider,
	getSandboxProvider,
	saveSandboxProvider,
} from "#/lib/sandbox-provider";
import { errorText, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/sandbox")({
	loader: () => getSandboxProvider(),
	component: SandboxProvider,
});

type SandboxTestResult = NonNullable<
	Awaited<ReturnType<typeof saveSandboxProvider>>["test"]
>;

const GiB = 1024 ** 3;

/** The one Sandbox Provider (orrery) with its write-only API Token. */
function SandboxProvider() {
	const existing = Route.useLoaderData();
	const router = useRouter();
	const [url, setUrl] = useState(existing?.url ?? "");
	const [token, setToken] = useState("");
	const [snapshot, setSnapshot] = useState(existing?.snapshot ?? "");
	const [cpu, setCpu] = useState(String(existing?.cpu ?? 2));
	const [memory, setMemory] = useState(
		String((existing?.memory ?? 2 * GiB) / GiB),
	);
	const [busy, setBusy] = useState<"save" | "delete">();
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [test, setTest] = useState<SandboxTestResult>();

	async function act(kind: "save" | "delete", action: () => Promise<void>) {
		setBusy(kind);
		setTest(undefined);
		try {
			await action();
			await router.invalidate();
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(undefined);
		}
	}

	const save = () =>
		act("save", async () => {
			const result = await saveSandboxProvider({
				data: {
					url,
					token,
					snapshot,
					cpu: Number(cpu),
					memory: Math.round(Number(memory) * GiB),
				},
			});
			setErrors(saveErrorTexts(result.errors));
			setTest(result.test);
			if (!Object.keys(result.errors).length) setToken("");
		});

	return (
		<ConsolePage
			title={m.sandbox_provider()}
			description={m.sandbox_provider_hint()}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						{existing ? "Orrery" : m.add_sandbox_provider()}
					</CardTitle>
					{existing && (
						<CardAction>
							<Button
								size="sm"
								variant="destructive"
								disabled={!!busy}
								onClick={() => {
									if (confirm(m.delete_sandbox_provider_confirm()))
										void act("delete", async () => {
											await deleteSandboxProvider();
											setErrors({});
											setToken("");
										});
								}}
							>
								{busy === "delete" && (
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{m.delete()}
							</Button>
						</CardAction>
					)}
				</CardHeader>
				<CardContent className="gap-5">
					{existing && !existing.tokenReadable && (
						<Alert variant="destructive">
							<TriangleAlertIcon />
							<AlertDescription>
								{m.sandbox_token_unreadable()}
							</AlertDescription>
						</Alert>
					)}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<FieldGroup className="gap-5">
							<div className="grid gap-5 md:grid-cols-2">
								<Field>
									<FieldLabel htmlFor="sandbox-url">
										{m.sandbox_url()}
									</FieldLabel>
									<Input
										id="sandbox-url"
										type="url"
										required
										pattern="https?://.*"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
									/>
								</Field>
								<Field data-invalid={!!errors.token || undefined}>
									<FieldLabel htmlFor="sandbox-token">
										{m.sandbox_token()}
									</FieldLabel>
									<Input
										id="sandbox-token"
										type="password"
										autoComplete="off"
										required={!existing?.tokenReadable}
										aria-invalid={!!errors.token || undefined}
										value={token}
										onChange={(e) => setToken(e.target.value)}
										placeholder={
											existing?.tokenReadable ? m.api_key_set() : "orr_…"
										}
									/>
									<FieldError>{errors.token}</FieldError>
								</Field>
							</div>
							<Field>
								<FieldLabel htmlFor="sandbox-snapshot">
									{m.sandbox_snapshot()}
								</FieldLabel>
								<Input
									id="sandbox-snapshot"
									value={snapshot}
									onChange={(e) => setSnapshot(e.target.value)}
									placeholder={m.sandbox_snapshot_default()}
								/>
								<FieldDescription>{m.sandbox_snapshot_hint()}</FieldDescription>
							</Field>
							<div className="grid gap-5 md:grid-cols-2">
								<Field>
									<FieldLabel htmlFor="sandbox-cpu">
										{m.sandbox_cpu()}
									</FieldLabel>
									<Input
										id="sandbox-cpu"
										type="number"
										required
										min={0.1}
										step={0.1}
										value={cpu}
										onChange={(e) => setCpu(e.target.value)}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="sandbox-memory">
										{m.sandbox_memory()}
									</FieldLabel>
									<Input
										id="sandbox-memory"
										type="number"
										required
										min={0.25}
										step={0.25}
										value={memory}
										onChange={(e) => setMemory(e.target.value)}
									/>
								</Field>
							</div>
							<Button
								type="submit"
								className="self-start"
								variant={existing ? "outline" : "default"}
								disabled={!!busy}
							>
								{busy === "save" && (
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{existing ? m.save() : m.add_sandbox_provider()}
							</Button>
							{test && <SandboxTestOutcome result={test} />}
							<FieldError>{errors[""]}</FieldError>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</ConsolePage>
	);
}

/** Whether a just-saved Sandbox Provider answered, or why connecting to it failed. */
function SandboxTestOutcome({ result }: { result: SandboxTestResult }) {
	if (result.ok)
		return (
			<Alert>
				<CheckCircle2Icon />
				<AlertDescription>{m.sandbox_test_ok()}</AlertDescription>
			</Alert>
		);
	const message = {
		auth: m.sandbox_test_auth,
		unreachable: m.sandbox_test_unreachable,
		timeout: m.sandbox_test_timeout,
		failed: m.sandbox_test_failed,
	}[result.reason];
	return (
		<Alert variant="destructive">
			<TriangleAlertIcon />
			<AlertDescription>{message({ detail: result.detail })}</AlertDescription>
		</Alert>
	);
}
