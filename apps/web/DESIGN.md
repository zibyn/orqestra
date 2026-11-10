# Design

Orqestra is where a person conducts Agents. The interface is the quiet stage; the Agents' work is the performance. Built on shadcn (`base-vega`, Base UI); reach for a shadcn component before writing markup by hand, and change the house copy in `src/components/ui` rather than overriding it at each use.

## Principles

1. **Colour means something is happening.** Everything at rest is cool grey. The one chroma, `signal` (indigo, hue 270), marks live work: an Agent running or streaming, a Tool call in flight, keyboard focus and links. Never use it for fills, buttons, headings or decoration; a screen with nothing running has no colour but focus and links.
2. **One surface per view.** The canvas (`bg-sidebar`) holds a single content panel (`bg-background`, 1px `border`, `rounded-xl`). Inside the panel, structure comes from whitespace and hairlines (`divide-y`, `border-b`), not from boxes inside boxes. A `Card` is for a block of settings, never for one item of a list.
3. **Lists stay lists.** Items are rows of one `ItemList`; adding and editing happen in a `Sheet` from the right, so the list never reflows around a form.
4. **Borders, not shadows.** Layers separate with a 1px `border`. Only floating layers (menus, popovers, sheets) keep the component's own shadow.
5. **Calm motion.** Motion only answers an action (a sheet sliding in, a disclosure opening) or shows live work (the `signal` spinner). No entrance animations, no hover lifts.
6. **One primary action per view.** The primary button is near-black in light mode and near-white in dark mode.

## Type

- **Inter Variable** with optical sizing (`opsz`, so large headings get Inter Display's tighter shapes) for everything, then the platform's CJK face (`PingFang SC`, `HarmonyOS Sans SC`, `Noto Sans SC`, `Microsoft YaHei`): Chinese is the default locale and must never fall back to an arbitrary system font. **Geist Mono** only for code, IDs and env var names.
- Scale:

  | px | Class | Use |
  | --- | --- | --- |
  | 12 | `text-xs` | meta: timestamps, counts, hints under rows |
  | 14 | `text-sm` | UI: lists, forms, buttons, menus |
  | 16 | `text-base` | message prose and sheet titles |
  | 24 | `text-2xl` | page titles |
  | 36 | `text-4xl` | the home greeting, the only display size (`text-3xl` below `sm`) |
- Weights: 400 body, 500 labels, item names and buttons, 600 page titles and the greeting. Never bold inside running text for emphasis.
- `h1`–`h3` are `tracking-tight text-balance` (set in `styles.css`). No all-caps labels and no eyebrow text above headings.
- Language: Chinese (`zh`) by default, English (`en`) available. All UI copy goes through Paraglide (`m.*()` from `#/paraglide/messages`, sources in `messages/*.json`); never hard-code user-facing strings. Copy is plain and active: a button says what it does ("添加 MCP Server", not "提交").

## Radius

`--radius` is `0.625rem`; radius grows with the size of the layer:

| Layer | Class |
| --- | --- |
| Badges, inline code | `rounded-sm` / `rounded-md` |
| Buttons, inputs, menu items | `rounded-md` (component default) |
| Lists, cards, the content panel | `rounded-xl` |
| The Composer | `rounded-2xl` |

## Theme

Follows the system by default; users can switch Light / Dark / System in the user menu (stored in `localStorage` under `theme`, applied before paint by the inline script in `__root.tsx`). Dark mode is not inverted light mode: the canvas is darker than the panel, and borders are white at 8%.

## Tokens

The single source of truth is `src/styles.css`. This table must match it exactly (`src/design-tokens.test.ts` enforces this); change both together. Greys carry a faint blue (hue 265) so the neutral palette and `signal` belong together.

| Token | Light (`:root`) | Dark (`.dark`) |
| --- | --- | --- |
| `--background` | `oklch(1 0 0)` | `oklch(0.185 0.005 265)` |
| `--foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--card` | `oklch(1 0 0)` | `oklch(0.21 0.006 265)` |
| `--card-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--popover` | `oklch(1 0 0)` | `oklch(0.22 0.006 265)` |
| `--popover-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--primary` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--primary-foreground` | `oklch(0.985 0.002 265)` | `oklch(0.21 0.006 265)` |
| `--secondary` | `oklch(0.965 0.003 265)` | `oklch(0.25 0.006 265)` |
| `--secondary-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--muted` | `oklch(0.965 0.003 265)` | `oklch(0.25 0.006 265)` |
| `--muted-foreground` | `oklch(0.53 0.012 265)` | `oklch(0.7 0.01 265)` |
| `--accent` | `oklch(0.955 0.004 265)` | `oklch(0.26 0.007 265)` |
| `--accent-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--destructive` | `oklch(0.577 0.215 27)` | `oklch(0.7 0.17 22)` |
| `--border` | `oklch(0.915 0.004 265)` | `oklch(1 0 0 / 8%)` |
| `--input` | `oklch(0.89 0.005 265)` | `oklch(1 0 0 / 13%)` |
| `--ring` | `oklch(0.55 0.15 270)` | `oklch(0.7 0.13 270)` |
| `--chart-1` | `oklch(0.87 0.004 265)` | `oklch(0.87 0.004 265)` |
| `--chart-2` | `oklch(0.7 0.008 265)` | `oklch(0.7 0.008 265)` |
| `--chart-3` | `oklch(0.53 0.012 265)` | `oklch(0.53 0.012 265)` |
| `--chart-4` | `oklch(0.38 0.01 265)` | `oklch(0.38 0.01 265)` |
| `--chart-5` | `oklch(0.27 0.008 265)` | `oklch(0.27 0.008 265)` |
| `--radius` | `0.625rem` | `—` |
| `--sidebar` | `oklch(0.975 0.003 265)` | `oklch(0.155 0.004 265)` |
| `--sidebar-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--sidebar-primary` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--sidebar-primary-foreground` | `oklch(0.985 0.002 265)` | `oklch(0.21 0.006 265)` |
| `--sidebar-accent` | `oklch(0.935 0.005 265)` | `oklch(0.23 0.006 265)` |
| `--sidebar-accent-foreground` | `oklch(0.21 0.006 265)` | `oklch(0.96 0.003 265)` |
| `--sidebar-border` | `oklch(0.915 0.004 265)` | `oklch(1 0 0 / 8%)` |
| `--sidebar-ring` | `oklch(0.55 0.15 270)` | `oklch(0.7 0.13 270)` |
| `--link` | `oklch(0.5 0.15 270)` | `oklch(0.76 0.11 270)` |
| `--signal` | `oklch(0.55 0.17 270)` | `oklch(0.72 0.14 270)` |

Use the Tailwind names (`bg-background`, `text-muted-foreground`, `border-border`, `text-link`, `text-signal`, ...), never raw colors.

## Layout

- **Both shells** (`src/routes/_app.tsx`, `src/routes/console.tsx`) use `Sidebar variant="inset"`: the sidebar sits on the canvas and the view is one bordered `SidebarInset` panel. The top bar is `h-12`. Below `md` the sidebar becomes a drawer opened by `SidebarTrigger` and the panel fills the screen.
- **App shell**: the panel is exactly the viewport minus its margin, and only the message list scrolls inside it.
  - Sidebar header: the "New conversation" button. Content: the Conversation list. Footer: the user menu (name, theme, language, `/console` for Admins, sign out).
- **New conversation** (`/`): the greeting (`text-4xl font-semibold`) and the Composer form one block centred a little above the middle of the panel; it is the first thing a person sees, so nothing else competes with it (no icon, no hint).
- **Messages** are centered in a column of `max-w-3xl` (48rem) with `px-4` gutters.
  - User messages: right-aligned, `bg-muted` bubble, `rounded-2xl px-4 py-2.5`, max ~80% width.
  - Agent replies: no bubble; Markdown rendered by AI Elements' `MessageResponse` (Streamdown with its own shadcn styles, no `prose`) aligned to the left of the column.
  - Built from the shadcn chat components: the thread is a `MessageScroller` (each turn a `MessageScrollerItem`, the User's turn its scroll anchor), turns are `Message`, the User's bubble is `Bubble variant="muted"`. Thinking, Tool calls and Subagents are `TraceLine`s, one `Trace` per run of them; Tool output is a `CodeBlock`; dividers (compaction, Notifications) are `Marker variant="separator"`; files are `Attachment`; the Composer is an `InputGroup`.
- **Standalone pages** (login, setup): a single `Card` centered on the screen, `max-w-sm`.
- **Console**: its own `Sidebar` (also `collapsible="icon"`), page padding `px-4 py-6`, `md:px-10 md:py-10`.
  - Sidebar header: Orqestra / Console. Content: nav groups (Models: Providers, Agents, Skills; Tools: Search Providers, MCP Servers, Sandbox Provider) and "Back to conversations" at the bottom. Footer: the same user menu as the app (`NavUser`).
  - Top bar: `SidebarTrigger`, a vertical `Separator` and a `Breadcrumb` (Console › page).
  - Pages use `ConsolePage` (centered `max-w-5xl`: title, one-line description, primary "Add" action in the header). Items are rows of one bordered `ItemList` (name with an outline `Badge` for its id, a muted line, then actions on the right: enable `Switch`, outline "Edit", icon `DeleteButton`), with an empty state when there are none; warnings use a destructive `Alert` under the row.
  - Adding and editing never happen in the list: they open a `FormSheet` (a right-side `Sheet`) whose `SheetForm` scrolls the fields and pins submit / cancel to the bottom. Page-wide settings that aren't items (Sandbox Provider, which Search Provider serves each Tool) stay inline in a `Card`.

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

- Use `FieldGroup` + `Field` (`FieldLabel`, `FieldDescription`, `FieldError`); switches in a list are horizontal `Field`s.
- Submit button goes last, full width in standalone cards (`w-full`).
- Errors: one line of `text-sm text-destructive` below the form (or under the field) — no toasts for form errors.

### Empty states

Centered in the available area: a muted lucide icon (`size-8 text-muted-foreground`), a `text-lg font-medium` title and one `text-sm text-muted-foreground` line. Offer the next action if there is one.

### Loading

- Lists and blocks: `Skeleton` (or `SidebarMenuSkeleton` in the sidebar) shaped like the content.
- Buttons doing work: `disabled` plus a `Loader2Icon` with `animate-spin` replacing the leading icon.
- Avoid full-page spinners.
- Live Agent work (a Run, a Tool call, a Subagent, the background spinner in the Conversation list) spins in `text-signal`; a button's own spinner stays in the button's colour.

### Code and identifiers

`font-mono text-sm`, inline code with `rounded bg-muted px-1 py-0.5`.

Code blocks in Agent replies: Streamdown's own `@streamdown/code` block as AI Elements ships it, unstyled by us; copy button only (no download), Shiki's `github-light` / `github-dark` token colors.
