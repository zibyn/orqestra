import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "#/components/ui/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";

/** A labelled Select over `items`, with an optional hint and error below. */
export function Picker({
	label,
	hint,
	error,
	value,
	onChange,
	items,
}: {
	label: string;
	hint?: string;
	error?: string;
	value: string;
	onChange: (value: string) => void;
	items: { value: string; label: string }[];
}) {
	return (
		<Field data-invalid={!!error || undefined}>
			<FieldLabel>{label}</FieldLabel>
			<Select
				items={items}
				value={value}
				onValueChange={(v) => v && onChange(v)}
			>
				<SelectTrigger
					aria-label={label}
					aria-invalid={!!error || undefined}
					className="min-w-48"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
			{hint && <FieldDescription>{hint}</FieldDescription>}
			<FieldError>{error}</FieldError>
		</Field>
	);
}
