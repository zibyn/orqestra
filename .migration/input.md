# input

2026-10-28, golden pair via CLI (`shadcn add input --overwrite` from the base-vega registry). Fresh re-init; the old new-york file had no consumers, so it was replaced outright.

## Changed

- `src/components/ui/input.tsx`: replaced the new-york/radix file with the stock base-vega file. Primitives: @base-ui/react/input .
- Leftover scan: `grep -n "radix-ui\|@radix-ui\|IconPlaceholder" src/components/ui/input.tsx` → clean.

## Left alone

- No app code imports this component, so there was no consumer sweep to do.

## Behavior changes

- The look changed from new-york/zinc to base-vega/neutral, as the user asked. Behavior otherwise matches stock Base UI.

## Verify by hand

- Type in it, Tab focuses it with a ring, the aria-invalid style shows red.
