# textarea

2026-10-28, golden pair via CLI (`shadcn add textarea --overwrite` from the base-vega registry). Fresh re-init; the old new-york file had no consumers, so it was replaced outright.

## Changed

- `src/components/ui/textarea.tsx`: replaced the new-york/radix file with the stock base-vega file. Primitives: none (plain element).
- Leftover scan: `grep -n "radix-ui\|@radix-ui\|IconPlaceholder" src/components/ui/textarea.tsx` → clean.

## Left alone

- No app code imports this component, so there was no consumer sweep to do.

## Behavior changes

- The look changed from new-york/zinc to base-vega/neutral, as the user asked. Behavior otherwise matches stock Base UI.

## Verify by hand

1985353{QA[textarea]}
