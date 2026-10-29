// Locale switcher refs:
// - Paraglide docs: https://inlang.com/m/gerre34r/library-inlang-paraglideJs
// - Router example: https://github.com/TanStack/router/tree/main/examples/react/i18n-paraglide#switching-locale
import { LanguagesIcon } from "lucide-react";
import {
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "#/components/ui/dropdown-menu";
import { m } from "#/paraglide/messages";
import {
	getLocale,
	type Locale,
	locales,
	setLocale,
} from "#/paraglide/runtime";

// Each language is named in itself, so it is findable whatever the current locale
const names: Record<Locale, string> = { zh: "中文", en: "English" };

/** Language submenu for a DropdownMenu; switching sets the locale cookie and reloads. */
export default function ParaglideLocaleSwitcher() {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<LanguagesIcon />
				{m.language_label()}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuRadioGroup
					value={getLocale()}
					onValueChange={(locale) => setLocale(locale as Locale)}
				>
					{locales.map((locale) => (
						<DropdownMenuRadioItem key={locale} value={locale}>
							{names[locale]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
