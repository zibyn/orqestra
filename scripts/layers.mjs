// Fails when a workspace package depends against the layers of ADR 0010, or web imports server code.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A package depends only on packages of a lower layer; same-layer and upward
// dependencies fail, so a cycle (which needs one upward edge) fails too.
// Tighten this table as #122 adds packages: db 0 · models/tools/mcp/skills/memory 1 · agents 2 · conversations 3 · api/worker 4.
const LAYERS = {
	"@orqestra/db": 0,
	"@orqestra/mcp": 1,
	"@orqestra/memory": 1,
	"@orqestra/models": 1,
	"@orqestra/skills": 1,
	"@orqestra/tools": 1,
	"@orqestra/agents": 2,
	"@orqestra/config": 2.5, // shortcut: sits between agents and conversations until #132 deletes it
	"@orqestra/conversations": 3,
	"@orqestra/api": 4,
	"@orqestra/worker": 4,
};
const WEB = "@orqestra/web";

/** deps: { [package]: workspace dependencies }, webImports: @orqestra specifiers imported by web */
function violations(deps, webImports) {
	const found = [];
	for (const [pkg, ds] of Object.entries(deps)) {
		if (pkg === WEB) continue;
		if (!(pkg in LAYERS)) {
			found.push(`${pkg} is not in the layer table of scripts/layers.mjs`);
			continue;
		}
		for (const d of ds) {
			if (d === WEB || !(LAYERS[d] < LAYERS[pkg]))
				found.push(
					`${pkg} (L${LAYERS[pkg]}) may not depend on ${d} (L${LAYERS[d] ?? "?"})`,
				);
		}
	}
	for (const s of webImports) {
		if (s !== "@orqestra/api" && !/^@orqestra\/[^/]+\/shared$/.test(s))
			found.push(`${WEB} may import only @orqestra/api and /shared entries, not ${s}`);
	}
	return found;
}

function selfCheck() {
	const ok = {
		"@orqestra/db": [],
		"@orqestra/tools": ["@orqestra/db"],
		"@orqestra/api": ["@orqestra/conversations", "@orqestra/db"],
	};
	assert.deepEqual(violations(ok, ["@orqestra/api", "@orqestra/config/shared"]), []);
	const bad = {
		reverse: [{ "@orqestra/db": ["@orqestra/tools"] }, []],
		sameLayer: [{ "@orqestra/api": ["@orqestra/worker"] }, []],
		cycle: [
			{
				"@orqestra/tools": ["@orqestra/config"],
				"@orqestra/config": ["@orqestra/tools"],
			},
			[],
		],
		onWeb: [{ "@orqestra/api": [WEB] }, []],
		unlisted: [{ "@orqestra/nope": [] }, []],
		webServerEntry: [{}, ["@orqestra/config"]],
		webDeepEntry: [{}, ["@orqestra/config/live"]],
	};
	for (const [name, [deps, imports]] of Object.entries(bad))
		assert.notDeepEqual(violations(deps, imports), [], `${name} should fail`);
}

function workspace(root) {
	const deps = {};
	for (const dir of ["apps", "packages"])
		for (const name of readdirSync(join(root, dir))) {
			const p = JSON.parse(
				readFileSync(join(root, dir, name, "package.json"), "utf8"),
			);
			deps[p.name] = Object.keys({
				...p.dependencies,
				...p.devDependencies,
				...p.peerDependencies,
			}).filter((d) => d.startsWith("@orqestra/"));
		}
	return deps;
}

function importsIn(dir) {
	const found = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const path = join(dir, e.name);
		if (e.isDirectory()) found.push(...importsIn(path));
		else if (/\.[cm]?[jt]sx?$/.test(e.name))
			for (const m of readFileSync(path, "utf8").matchAll(
				/(?:from|import)\s*\(?\s*["'](@orqestra\/[^"']+)["']/g,
			))
				found.push(m[1]);
	}
	return found;
}

selfCheck();
const root = join(import.meta.dirname, "..");
const found = violations(workspace(root), importsIn(join(root, "apps/web")));
if (found.length) {
	console.error(found.join("\n"));
	process.exit(1);
}
