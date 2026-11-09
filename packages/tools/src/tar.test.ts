import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tar } from "./tar.ts";

describe("tar", () => {
	it("packs files that the system tar unpacks as they were", () => {
		const dir = mkdtempSync(join(tmpdir(), "tar-test-"));
		const long = `${"deep/".repeat(25)}file.txt`; // past the 100-byte name field
		const archive = tar([
			{ path: "pdf/SKILL.md", content: Buffer.from("# PDF\n") },
			{ path: "pdf/scripts/run.py", content: Buffer.from("print('ünï')") },
			{ path: `pdf/${long}`, content: Buffer.alloc(0) },
		]);
		writeFileSync(join(dir, "a.tar"), archive);
		execFileSync("tar", ["-xf", "a.tar"], { cwd: dir });

		expect(readFileSync(join(dir, "pdf/SKILL.md"), "utf8")).toBe("# PDF\n");
		expect(readFileSync(join(dir, "pdf/scripts/run.py"), "utf8")).toBe(
			"print('ünï')",
		);
		expect(readFileSync(join(dir, "pdf", long), "utf8")).toBe("");
	});
});
