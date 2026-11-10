// PROTOTYPE (#81 MCP 连接流程界面): throwaway, never merge to main. Fake data, nothing saved.
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	CopyIcon,
	UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";

export type ProtoAuth = "shared" | "oauth";

/** The fake per-User server added to the console list in dev. */
export const FAKE_OAUTH_SERVER = {
	id: "github",
	name: "GitHub",
	url: "https://api.githubcopilot.com/mcp/",
	enabled: true,
	headers: [],
};

const USERS = [
	{ name: "zibyn", since: "2026-10-28 14:02", state: "connected" },
	{ name: "李雷", since: "2026-10-30 09:41", state: "connected" },
	{ name: "韩梅梅", since: "2026-09-12 18:20", state: "reconnect" },
] as const;

/** The auth-mode switch at the top of McpServerForm, with the OAuth fields under it. */
export function AuthModeFields({
	mode,
	onMode,
	existing,
}: {
	mode: ProtoAuth;
	onMode: (m: ProtoAuth) => void;
	existing: boolean;
}) {
	const [advanced, setAdvanced] = useState(false);
	return (
		<FieldSet className="gap-3">
			<FieldLegend variant="label">认证方式</FieldLegend>
			<ToggleGroup
				variant="outline"
				spacing={0}
				className="w-full"
				value={[mode]}
				onValueChange={([k]) => k && onMode(k as ProtoAuth)}
			>
				<ToggleGroupItem value="shared" className="flex-1">
					共享
				</ToggleGroupItem>
				<ToggleGroupItem value="oauth" className="flex-1">
					按用户 OAuth
				</ToggleGroupItem>
			</ToggleGroup>
			<FieldDescription>
				{mode === "shared"
					? "所有 User 共用下面填的请求头（例如一个 API key）。"
					: "每个 User 用自己的账号登录这个服务；第一次用到时，对话里会请 User 连接。你看得到谁连接了，看不到他们的令牌。"}
			</FieldDescription>
			{mode === "oauth" && (
				<>
					{existing && (
						<Alert>
							<AlertDescription>
								改认证方式、URL 或预注册的 Client 后，所有 User
								的连接都会被删除，需要重新连接。
							</AlertDescription>
						</Alert>
					)}
					<Collapsible open={advanced} onOpenChange={setAdvanced}>
						<CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
							<ChevronDownIcon
								className={`size-4 transition-transform ${advanced ? "" : "-rotate-90"}`}
							/>
							预注册的 Client（可选）
						</CollapsibleTrigger>
						<CollapsibleContent className="flex flex-col gap-3 pt-3">
							<FieldDescription>
								一般不用填：Orqestra 会先用自己的 Client ID Metadata
								Document，服务端不支持时再动态注册。只有服务端要求事先注册应用时才填。
							</FieldDescription>
							<Field>
								<FieldLabel>回调地址（注册应用时填这个）</FieldLabel>
								<div className="flex gap-2">
									<Input
										readOnly
										className="font-mono"
										value="https://orqestra.example.com/oauth/callback"
									/>
									<Button
										type="button"
										size="icon"
										variant="outline"
										aria-label="复制"
									>
										<CopyIcon />
									</Button>
								</div>
							</Field>
							<Field>
								<FieldLabel>Client ID</FieldLabel>
								<Input className="font-mono" />
							</Field>
							<Field>
								<FieldLabel>Client Secret</FieldLabel>
								<Input type="password" autoComplete="off" />
							</Field>
						</CollapsibleContent>
					</Collapsible>
				</>
			)}
		</FieldSet>
	);
}

/** Under the headers when OAuth is picked. */
export const OAuthHeadersHint = () => (
	<FieldDescription>
		这里只填和认证无关的请求头；Authorization 由各 User 的连接提供，不能填。
	</FieldDescription>
);

/** Under a per-User server's row: the badge text and the connected Users list. */
export function ConnectedUsers() {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
				<ChevronDownIcon
					className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`}
				/>
				<UsersIcon className="size-4" />
				{USERS.length} 个 User 已连接
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-2">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>User</TableHead>
							<TableHead>连接时间</TableHead>
							<TableHead>状态</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{USERS.map((u) => (
							<TableRow key={u.name}>
								<TableCell>{u.name}</TableCell>
								<TableCell className="text-muted-foreground">
									{u.since}
								</TableCell>
								<TableCell>
									{u.state === "connected" ? (
										<Badge variant="outline">已连接</Badge>
									) : (
										<Badge variant="destructive">需要重新连接</Badge>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
				<p className="pt-2 text-xs text-muted-foreground">
					看不到令牌，也不能替 User 断开。
				</p>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** The console test of a per-User server: discovery only. */
export const OAuthTestOutcome = () => (
	<Alert>
		<CheckCircle2Icon />
		<AlertTitle>能找到 GitHub 的授权服务器</AlertTitle>
		<AlertDescription>
			受保护资源元数据、授权服务器元数据都在，支持 PKCE（S256）。Tools 要等有
			User 连接后才看得到。
		</AlertDescription>
	</Alert>
);
