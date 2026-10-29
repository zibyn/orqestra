# Design

Modern and minimal, in the spirit of Vercel, Linear and v0. Built on shadcn (`base-vega`, `neutral`, Base UI); reach for a shadcn component before writing markup by hand.

## Direction

- **Black, white and grey.** No brand color. The primary button is near-black in light mode and near-white in dark mode.
- **Blue only for focus and links**: a low-saturation blue (`--ring`, `--link`). Never use it for fills, buttons or decoration.
- **Borders, not shadows.** Separate layers with a 1px `border` (`--border`). Avoid `shadow-*`; popovers and menus keep the component default and nothing else adds one.
- **Type**: Inter (`font-sans`) for everything, Geist Mono (`font-mono`) for code, IDs and env var names.
- **Radius**: `--radius` is `0.625rem`; use the `rounded-*` scale derived from it instead of fixed values.
- **Theme** follows the system by default; users can switch Light / Dark / System in the user menu (stored in `localStorage` under `theme`, applied before paint by the inline script in `__root.tsx`).
- **Language**: Chinese (`zh`) by default, English (`en`) available. All UI copy goes through Paraglide (`m.*()` from `#/paraglide/messages`, sources in `messages/*.json`); never hard-code user-facing strings.

## Tokens

The single source of truth is `src/styles.css`. This table must match it exactly (`src/design-tokens.test.ts` enforces this); change both together.

| Token | Light (`:root`) | Dark (`.dark`) |
| --- | --- | --- |
| `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `--card` | `oklch(1 0 0)` | `oklch(0.205 0 0)` |
| `--card-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `--popover` | `oklch(1 0 0)` | `oklch(0.205 0 0)` |
| `--popover-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `--primary` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| `--secondary` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--secondary-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--muted` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` |
| `--accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--accent-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |
| `--border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` |
| `--input` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 15%)` |
| `--ring` | `oklch(0.6 0.08 250)` | `oklch(0.68 0.08 250)` |
| `--chart-1` | `oklch(0.87 0 0)` | `oklch(0.87 0 0)` |
| `--chart-2` | `oklch(0.556 0 0)` | `oklch(0.556 0 0)` |
| `--chart-3` | `oklch(0.439 0 0)` | `oklch(0.439 0 0)` |
| `--chart-4` | `oklch(0.371 0 0)` | `oklch(0.371 0 0)` |
| `--chart-5` | `oklch(0.269 0 0)` | `oklch(0.269 0 0)` |
| `--radius` | `0.625rem` | `—` |
| `--sidebar` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| `--sidebar-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` |
| `--sidebar-primary` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--sidebar-primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| `--sidebar-accent` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` |
| `--sidebar-accent-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| `--sidebar-border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` |
| `--sidebar-ring` | `oklch(0.6 0.08 250)` | `oklch(0.68 0.08 250)` |
| `--link` | `oklch(0.5 0.1 250)` | `oklch(0.75 0.08 250)` |

Use the Tailwind names (`bg-background`, `text-muted-foreground`, `border-border`, `text-link`, ...), never raw colors.

## Layout

- **App shell** (`src/routes/_app.tsx`): shadcn `Sidebar` on the left, `SidebarInset` on the right. Below `md` the sidebar becomes a drawer opened by `SidebarTrigger` in the top bar.
  - Sidebar header: the "New conversation" button. Content: the Conversation list. Footer: the user menu (name, theme, language, `/console` for Admins, sign out).
- **Messages** are centered in a column of `max-w-3xl` (48rem) with `px-4` gutters.
  - User messages: right-aligned, `bg-muted` bubble, `rounded-2xl px-4 py-2.5`, max ~80% width.
  - Agent replies: no bubble; plain prose (`prose prose-neutral dark:prose-invert`) aligned to the left of the column.
- **Standalone pages** (login, setup): a single `Card` centered on the screen, `max-w-sm`.
- **Console**: centered `max-w-4xl` column with a page header, a tab-like nav and content below.

## Components

### Buttons

| Variant | Use for |
| --- | --- |
| `default` | The one primary action of a view (submit, "Sign in"). At most one per view. |
| `outline` | Secondary actions next to a primary one, and actions in table rows. |
| `secondary` | Prominent but non-primary, e.g. "New conversation" in the sidebar. |
| `ghost` | Toolbar and icon buttons (sidebar trigger, menu triggers). |
| `destructive` | Irreversible or harmful actions (ban, delete). |
| `link` | Inline text actions; renders in `--link` blue. |

Icon-only buttons use `size="icon"` / `icon-sm` and must have an `aria-label` or `sr-only` text.

### Forms

- Stack fields with `flex flex-col gap-4`; each field is a `Label` above its `Input` (`gap-2`).
- Submit button goes last, full width in standalone cards (`w-full`).
- Errors: one line of `text-sm text-destructive` below the form (or under the field) — no toasts for form errors.

### Empty states

Centered in the available area: a muted lucide icon (`size-8 text-muted-foreground`), a `text-lg font-medium` title and one `text-sm text-muted-foreground` line. Offer the next action if there is one.

### Loading

- Lists and blocks: `Skeleton` (or `SidebarMenuSkeleton` in the sidebar) shaped like the content.
- Buttons doing work: `disabled` plus a `Loader2Icon` with `animate-spin` replacing the leading icon.
- Avoid full-page spinners.

### Code and identifiers

`font-mono text-sm`, inline code with `rounded bg-muted px-1 py-0.5`.

Code blocks in Agent replies (Streamdown with `@streamdown/code`, styled by the `[data-streamdown="code-block*"]` rules in `src/styles.css`): one `rounded-lg` block with a single 1px `border` and `bg-muted/50`, no shadow or nested card; a slim header with the language in `text-xs text-muted-foreground` and a ghost copy button (no download); body in `font-mono text-sm`, keeping Shiki's `github-light` / `github-dark` token colors.
