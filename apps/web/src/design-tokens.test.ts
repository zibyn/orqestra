import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

/** `--name: value;` declarations inside the first `selector { ... }` block. */
function cssTokens(css: string, selector: string) {
	const start = css.indexOf(`${selector} {`);
	const block = css.slice(start, css.indexOf("}", start));
	return Object.fromEntries(
		[...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
	);
}

/** Rows of the DESIGN.md token table: | `--name` | `light` | `dark` | */
function designTokens(md: string) {
	const light: Record<string, string> = {};
	const dark: Record<string, string> = {};
	for (const m of md.matchAll(
		/^\| `(--[\w-]+)` \| `([^`]+)` \| `([^`]+)` \|/gm,
	)) {
		light[m[1]] = m[2];
		if (m[3] !== "—") dark[m[1]] = m[3];
	}
	return { light, dark };
}

test("DESIGN.md documents exactly the color tokens in styles.css", () => {
	const css = read("./styles.css");
	const { light, dark } = designTokens(read("../DESIGN.md"));
	expect(light).toEqual(cssTokens(css, ":root"));
	expect(dark).toEqual(cssTokens(css, ".dark"));
});
