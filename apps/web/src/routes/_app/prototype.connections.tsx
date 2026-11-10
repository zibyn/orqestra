// PROTOTYPE (#81 MCP 连接流程界面): throwaway, never merge to main. Fake data, no API.
import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CircleDashedIcon,
	ExternalLinkIcon,
	PlugIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { ConsolePage, Item, ItemList } from "#/components/ConsolePage";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_app/prototype/connections")({
	component: Connections,
});

type Row = {
	id: string;
	name: string;
	agents: string[];
	state: "connected" | "reconnect" | "none";
	since?: string;
	account?: string;
	disabled?: boolean;
};

const FAKE: Row[] = [
	{
		id: "github",
		name: "GitHub",
		agents: ["通用助手", "代码审查"],
		state: "connected",
		since: "2026-10-28",
		account: "zibyn",
	},
	{
		id: "linear",
		name: "Linear",
		agents: ["通用助手"],
		state: "reconnect",
		since: "2026-09-02",
		account: "zibyn@…",
	},
	{
		id: "notion",
		name: "Notion",
		agents: ["写作助手"],
		state: "none",
	},
	{
		id: "sentry",
		name: "Sentry",
		agents: ["值班助手"],
		state: "connected",
		since: "2026-08-15",
		account: "orqestra-team",
		disabled: true,
	},
];

/** 「连接」: every per-User MCP Server, with the User's own Connection to it. */
function Connections() {
	const [rows, setRows] = useState(FAKE);
	const set = (id: string, patch: Partial<Row>) =>
		setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage
				title="连接"
				description="有些 MCP Server 需要用你自己的账号登录。在这里提前连接、查看状态或断开；你的对话、Subagent 和定时任务都用这些连接。"
			>
				<ItemList
					empty={{
						icon: PlugIcon,
						title: "没有需要连接的服务",
						hint: "Admin 还没有添加需要按用户登录的 MCP Server。",
					}}
				>
					{rows.map((r) => (
						<Item
							key={r.id}
							title={
								<>
									{r.name}
									{r.state === "connected" && (
										<Badge variant="outline">
											<CheckCircle2Icon />
											已连接
										</Badge>
									)}
									{r.state === "reconnect" && (
										<Badge variant="destructive">
											<TriangleAlertIcon />
											需要重新连接
										</Badge>
									)}
									{r.state === "none" && (
										<Badge variant="secondary">
											<CircleDashedIcon />
											未连接
										</Badge>
									)}
									{r.disabled && <Badge variant="outline">Admin 已停用</Badge>}
								</>
							}
							description={
								<>
									{r.agents.join("、")} 会用到
									{r.since && ` · ${r.account} · ${r.since} 连接`}
								</>
							}
							actions={
								r.state === "connected" ? (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											if (
												confirm(
													`断开 ${r.name}？Agent 之后调用它时会请你重新连接，定时任务里的调用会失败。`,
												)
											)
												set(r.id, { state: "none", since: undefined });
										}}
									>
										断开
									</Button>
								) : (
									<>
										{r.state === "reconnect" && (
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													set(r.id, { state: "none", since: undefined })
												}
											>
												断开
											</Button>
										)}
										<Button
											size="sm"
											onClick={() =>
												set(r.id, {
													state: "connected",
													since: "2026-11-10",
													account: r.account ?? "zibyn",
												})
											}
										>
											<ExternalLinkIcon data-icon="inline-start" />
											{r.state === "reconnect" ? "重新连接" : "连接"}
										</Button>
									</>
								)
							}
						>
							{r.state === "reconnect" && (
								<p className="text-xs text-muted-foreground">
									{r.name}{" "}
									不再接受这个连接（过期或被撤销）。重新连接之前，对话里会请你连接，定时任务里的调用会失败。
								</p>
							)}
							{r.disabled && (
								<p className="text-xs text-muted-foreground">
									Admin 停用了 {r.name}
									，暂时用不了；连接会保留，恢复后照常使用。
								</p>
							)}
						</Item>
					))}
				</ItemList>
				<p className="text-xs text-muted-foreground">
					原型说明：只列按用户 OAuth 的 MCP
					Server；共享方式的不出现。「连接」会打开 {""}
					授权弹窗，这里直接模拟成功。
				</p>
			</ConsolePage>
		</div>
	);
}
