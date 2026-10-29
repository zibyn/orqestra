import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";

/** A labelled Select over `items`, with an optional error below. */
export function Picker({
	label,
	error,
	value,
	onChange,
	items,
}: {
	label: string;
	error?: string;
	value: string;
	onChange: (value: string) => void;
	items: { value: string; label: string }[];
}) {
	return (
		<div className="flex flex-col gap-2">
			<Label>{label}</Label>
			<Select
				items={items}
				value={value}
				onValueChange={(v) => v && onChange(v)}
			>
				<SelectTrigger aria-label={label} className="min-w-48 self-start">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{error && <p className="text-destructive">{error}</p>}
		</div>
	);
}
