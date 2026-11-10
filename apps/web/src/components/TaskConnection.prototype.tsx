// PROTOTYPE (#81 MCP 连接流程界面): throwaway, never merge to main. Fake data.
import { Link } from "@tanstack/react-router";
import { BellIcon, PlugIcon, TriangleAlertIcon } from "lucide-react";
import { Item, ItemList } from "#/components/ConsolePage";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";

/** Under the Agent picker of TaskForm: the per-User MCP Servers this Agent uses that the User has not connected. */
export function TaskConnectionHint({ agentName }: { agentName: string }) {
	if (!import.meta.env.DEV) return null;
	return (
		<Alert>
			<PlugIcon />
			<AlertTitle>{agentName} 会用到 Linear、Notion，你还没连接</AlertTitle>
			<AlertDescription>
				<p>
					定时任务运行时没人在场，不会停下来等你连接：用到它们的调用会失败，Agent
					跳过继续，并提醒你去连接。Linear 的连接已失效，需要重新连接。
				</p>
				<Button
					size="sm"
					variant="outline"
					className="mt-2"
					nativeButton={false}
					render={<Link to="/prototype/connections" target="_blank" />}
				>
					去「连接」页
				</Button>
			</AlertDescription>
		</Alert>
	);
}

/** On /tasks: what a Firing that hit a missing Connection looks like — its row, and the push it sent. */
export function FiringAlertPrototype() {
	if (!import.meta.env.DEV) return null;
	return (
		<div className="flex flex-col gap-3 rounded-xl border border-dashed border-fuchsia-500 p-4">
			<p className="text-xs text-fuchsia-600">
				原型 #81：Firing 缺连接时的样子（假数据）
			</p>
			<ItemList>
				{[
					<Item
						key="fake"
						title={
							<>
								每日 bug 汇总 <Badge variant="outline">进行中</Badge>
							</>
						}
						description="每天 09:00 · 下次 明天 09:00"
					>
						<p className="flex items-center gap-2 text-xs">
							<TriangleAlertIcon className="size-4 text-amber-500" />
							上次运行 今天 09:00：已完成，但没用上 Linear（需要连接）
							<Link to="/prototype/connections" className="underline">
								去连接
							</Link>
						</p>
					</Item>,
				]}
			</ItemList>
			<div className="flex max-w-sm gap-3 rounded-lg bg-muted p-3 text-sm shadow">
				<BellIcon className="mt-0.5 size-4 shrink-0" />
				<div>
					<p className="font-medium">「每日 bug 汇总」需要连接 Linear</p>
					<p className="text-muted-foreground">
						这次运行没能使用 Linear，结果可能不完整。连接后，下次运行就能用了。
					</p>
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				推送通知（不管这个任务有没有开完成提醒都会发）。点开去「连接」页；Firing
				的 Conversation 里，失败的那次调用照常显示为 Trace 里的错误行。
			</p>
		</div>
	);
}
