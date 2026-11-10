import { isMineruNet, MINERU_URL } from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckCircle2Icon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
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
import { Switch } from "#/components/ui/switch";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

const saveDocumentParser = (
	parser: Parameters<
		ReturnType<typeof api>["api"]["document-parser"]["post"]
	>[0],
) => saved(api().api["document-parser"].post(parser));

export const Route = createFileRoute("/console/parse")({
	loader: async () => (await ok(api().api["document-parser"].get())).parser,
	component: DocumentParser,
});

type ParserTestResult = NonNullable<
	Awaited<ReturnType<typeof saveDocumentParser>>["test"]
>;

/** The one Document Parser (MinerU) with its write-only key. */
function DocumentParser() {
	const existing = Route.useLoaderData();
	const router = useRouter();
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [url, setUrl] = useState(existing?.url ?? MINERU_URL);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState<"save" | "delete">();
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [test, setTest] = useState<ParserTestResult>();

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
			const result = await saveDocumentParser({ enabled, url, apiKey });
			setErrors(saveErrorTexts(result.errors));
			setTest(result.test);
			if (!Object.keys(result.errors).length) setApiKey("");
		});

	return (
		<ConsolePage
			title={m.document_parser()}
			description={m.document_parser_hint()}
		>
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						{existing ? m.mineru() : m.add_document_parser()}
						{existing && (
							<Badge variant="outline" className="font-mono">
								{existing.url}
							</Badge>
						)}
					</CardTitle>
					{existing && (
						<CardAction>
							<Button
								size="sm"
								variant="destructive"
								disabled={!!busy}
								onClick={() => {
									if (confirm(m.delete_document_parser_confirm()))
										void act("delete", async () => {
											await ok(api().api["document-parser"].delete());
											setErrors({});
											setApiKey("");
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
					{existing?.keyReadable === false && (
						<Alert variant="destructive">
							<TriangleAlertIcon />
							<AlertDescription>
								{m.document_parser_key_unreadable()}
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
							<Field orientation="horizontal">
								<Switch
									id="parser-enabled"
									checked={enabled}
									onCheckedChange={setEnabled}
								/>
								<FieldLabel htmlFor="parser-enabled">
									{m.document_parser_enabled()}
								</FieldLabel>
							</Field>
							<div className="grid gap-5 md:grid-cols-2">
								<Field>
									<FieldLabel htmlFor="parser-url">
										{m.document_parser_url()}
									</FieldLabel>
									<Input
										id="parser-url"
										type="url"
										required
										pattern="https?://.*"
										value={url}
										onChange={(e) => setUrl(e.target.value)}
									/>
									<FieldDescription>
										{m.document_parser_url_hint()}
									</FieldDescription>
								</Field>
								<Field data-invalid={!!errors.apiKey || undefined}>
									<FieldLabel htmlFor="parser-key">{m.api_key()}</FieldLabel>
									<Input
										id="parser-key"
										type="password"
										autoComplete="off"
										required={isMineruNet(url) && !existing?.keyReadable}
										aria-invalid={!!errors.apiKey || undefined}
										value={apiKey}
										onChange={(e) => setApiKey(e.target.value)}
										placeholder={
											existing?.keyReadable ? m.api_key_set() : undefined
										}
									/>
									<FieldDescription>
										{m.document_parser_key_hint()}
									</FieldDescription>
									<FieldError>{errors.apiKey}</FieldError>
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
								{existing ? m.save() : m.add_document_parser()}
							</Button>
							{test && <ParserTestOutcome result={test} />}
							<FieldError>{errors[""]}</FieldError>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</ConsolePage>
	);
}

/** Whether a just-saved Document Parser answered, or why connecting to it failed. */
function ParserTestOutcome({ result }: { result: ParserTestResult }) {
	if (result.ok)
		return (
			<Alert>
				<CheckCircle2Icon />
				<AlertDescription>{m.document_parser_test_ok()}</AlertDescription>
			</Alert>
		);
	const message = {
		auth: m.document_parser_test_auth,
		unreachable: m.document_parser_test_unreachable,
		timeout: m.document_parser_test_timeout,
		failed: m.sandbox_test_failed,
	}[result.reason];
	return (
		<Alert variant="destructive">
			<TriangleAlertIcon />
			<AlertDescription>{message({ detail: result.detail })}</AlertDescription>
		</Alert>
	);
}
