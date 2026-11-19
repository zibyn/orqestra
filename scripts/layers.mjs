// Fails when a workspace package depends against the layers of ADR 0010, web imports server code, or an app reads or writes tables.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A package depends only on packages of a lower layer; same-layer and upward
// dependencies fail, so a cycle (which needs one upward edge) fails too.
const LAYERS = {
	"@orqestra/db": 0,
	// the outside systems' clients, below every capability that uses them (ADR 0018)
	"@orqestra/integrations": 1,
	"@orqestra/mcp": 2,
	"@orqestra/memory": 2,
	"@orqestra/models": 2,
	"@orqestra/skills": 2,
	"@orqestra/tools": 2,
	"@orqestra/agents": 3,
	"@orqestra/conversations": 4,
	"@orqestra/api": 5,
	"@orqestra/worker": 5,
};
const WEB = "@orqestra/web";
// the outside systems' clients (ADR 0018): below every capability, reached only through its entries, one per adapter directory and one for the list of WorkSources
const INTEGRATIONS = "@orqestra/integrations";
// assembly only (ADR 0010): their tables are read and written by the capability packages, so their runtime code needs no drizzle-orm
const APPS = ["@orqestra/api", "@orqestra/worker"];

/**
 * deps: { [package]: workspace dependencies }, webImports: @orqestra specifiers imported by web,
 * apps: { [app]: { dependencies: its runtime dependencies, imports: specifiers its non-test source imports } },
 * imports: { [package]: @orqestra specifiers its source imports }
 */
function violations(deps, webImports, apps = {}, imports = {}) {
	const found = [];
	for (const [pkg, ds] of Object.entries(deps)) {
		if (pkg === WEB) continue;
		if (!(pkg in LAYERS)) {
			found.push(`${pkg} is not in the layer table of scripts/layers.mjs`);
			continue;
		}
		for (const d of ds) {
			if (pkg === INTEGRATIONS && d !== "@orqestra/db")
				found.push(`${INTEGRATIONS} may depend on no capability package, not ${d}`);
			else if (d === WEB || !(LAYERS[d] < LAYERS[pkg]))
				found.push(
					`${pkg} (L${LAYERS[pkg]}) may not depend on ${d} (L${LAYERS[d] ?? "?"})`,
				);
		}
	}
	for (const s of webImports) {
		if (s !== "@orqestra/api" && !/^@orqestra\/[^/]+\/shared$/.test(s))
			found.push(`${WEB} may import only @orqestra/api and /shared entries, not ${s}`);
	}
	for (const [pkg, specifiers] of Object.entries(imports))
		for (const s of specifiers)
			if (s.startsWith(`${INTEGRATIONS}/`) && s.split("/").length > 3)
				found.push(`${pkg} may import ${INTEGRATIONS} only through its entries, not ${s}`);
	for (const [app, { dependencies, imports }] of Object.entries(apps)) {
		if (dependencies.includes("drizzle-orm"))
			found.push(`${app} may list drizzle-orm only in devDependencies, for its tests`);
		for (const s of imports)
			if (s === "drizzle-orm" || s.startsWith("drizzle-orm/"))
				found.push(`${app}'s runtime source may not import ${s}: a capability package reads and writes its tables`);
	}
	return found;
}

function selfCheck() {
	const ok = {
		"@orqestra/db": [],
		"@orqestra/tools": ["@orqestra/db"],
		"@orqestra/api": ["@orqestra/conversations", "@orqestra/db"],
	};
	const okApp = {
		"@orqestra/worker": { dependencies: ["@orqestra/db"], imports: ["@orqestra/db", "bullmq"] },
	};
	const okImports = {
		"@orqestra/tools": [INTEGRATIONS, `${INTEGRATIONS}/orrery`, `${INTEGRATIONS}/testing`, `${INTEGRATIONS}/sources`],
	};
	assert.deepEqual(
		violations(
			{ ...ok, [INTEGRATIONS]: ["@orqestra/db"] },
			["@orqestra/api", "@orqestra/tools/shared", `${INTEGRATIONS}/shared`],
			okApp,
			okImports,
		),
		[],
	);
	const bad = {
		reverse: [{ "@orqestra/db": ["@orqestra/tools"] }, []],
		sameLayer: [{ "@orqestra/api": ["@orqestra/worker"] }, []],
		cycle: [
			{
				"@orqestra/tools": ["@orqestra/agents"],
				"@orqestra/agents": ["@orqestra/tools"],
			},
			[],
		],
		onWeb: [{ "@orqestra/api": [WEB] }, []],
		unlisted: [{ "@orqestra/nope": [] }, []],
		webServerEntry: [{}, ["@orqestra/conversations"]],
		webDeepEntry: [{}, ["@orqestra/agents/live"]],
		appImportsDrizzle: [{}, [], { "@orqestra/worker": { dependencies: [], imports: ["drizzle-orm"] } }],
		appImportsDrizzleEntry: [{}, [], { "@orqestra/api": { dependencies: [], imports: ["drizzle-orm/pg-core"] } }],
		appDependsOnDrizzle: [{}, [], { "@orqestra/worker": { dependencies: ["drizzle-orm"], imports: [] } }],
	};
	const badImports = {
		intoAdapterDir: { "@orqestra/tools": [`${INTEGRATIONS}/orrery/client.ts`] },
		intoSource: { "@orqestra/worker": [`${INTEGRATIONS}/src/installation.ts`] },
	};
	for (const [name, imports] of Object.entries(badImports))
		bad[name] = [{}, [], {}, imports];
	// its own rule, not only the layers: it holds were a capability package ever put at L0
	assert.ok(
		violations({ [INTEGRATIONS]: ["@orqestra/tools"] }, []).some((v) =>
			v.includes("may depend on no capability package"),
		),
		"integrationsOnCapability should fail",
	);
	for (const [name, [deps, imports, apps, pkgImports]] of Object.entries(bad))
		assert.notDeepEqual(
			violations(deps, imports, apps, pkgImports),
			[],
			`${name} should fail`,
		);
}

/** Each workspace package's @orqestra imports, by package name. */
function workspaceImports(root) {
	const found = {};
	for (const dir of ["apps", "packages"])
		for (const name of readdirSync(join(root, dir))) {
			const p = JSON.parse(readFileSync(join(root, dir, name, "package.json"), "utf8"));
			found[p.name] = importsIn(join(root, dir, name)).filter((s) =>
				s.startsWith("@orqestra/"),
			);
		}
	return found;
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

/** The bare specifiers imported under `dir`, skipping files `skip` matches. */
function importsIn(dir, skip = /^$/) {
	const found = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const path = join(dir, e.name);
		if (e.isDirectory()) found.push(...importsIn(path, skip));
		else if (/\.[cm]?[jt]sx?$/.test(e.name) && !skip.test(e.name))
			for (const m of readFileSync(path, "utf8").matchAll(
				/(?:from|import)\s*\(?\s*["']([^."'/][^"']*)["']/g,
			))
				found.push(m[1]);
	}
	return found;
}

// what each app's runtime loads: test files and the test-only env setup excluded
const TEST_FILE = /\.test\.[cm]?[jt]sx?$|^test-env\.ts$/;
function apps(root) {
	const found = {};
	for (const name of readdirSync(join(root, "apps"))) {
		const p = JSON.parse(readFileSync(join(root, "apps", name, "package.json"), "utf8"));
		if (APPS.includes(p.name))
			found[p.name] = {
				dependencies: Object.keys({ ...p.dependencies, ...p.peerDependencies }),
				imports: importsIn(join(root, "apps", name, "src"), TEST_FILE),
			};
	}
	return found;
}

selfCheck();
const root = join(import.meta.dirname, "..");
const found = violations(
	workspace(root),
	importsIn(join(root, "apps/web")).filter((s) => s.startsWith("@orqestra/")),
	apps(root),
	workspaceImports(root),
);
if (found.length) {
	console.error(found.join("\n"));
	process.exit(1);
}
