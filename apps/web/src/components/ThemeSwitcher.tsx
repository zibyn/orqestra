import { SunMoonIcon } from "lucide-react";
import { useState } from "react";
import {
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "#/components/ui/dropdown-menu";
import { applyTheme, type Theme, themes } from "#/lib/theme";
import { m } from "#/paraglide/messages";

const labels: Record<Theme, () => string> = {
	system: m.theme_system,
	light: m.theme_light,
	dark: m.theme_dark,
};

/** Theme submenu for a DropdownMenu; only mounted on the client when the menu opens. */
export function ThemeSwitcher() {
	const [theme, setTheme] = useState(
		() => localStorage.getItem("theme") ?? "system",
	);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<SunMoonIcon />
				{m.theme_label()}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuRadioGroup
					value={theme}
					onValueChange={(value) => {
						localStorage.setItem("theme", value);
						setTheme(value);
						applyTheme();
					}}
				>
					{themes.map((t) => (
						<DropdownMenuRadioItem key={t} value={t}>
							{labels[t]()}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
