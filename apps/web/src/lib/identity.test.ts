import { describe, expect, it } from "vitest";
import {
	bootstrapDefaultAdmin,
	canUsePassword,
	displayName,
	polarisUser,
} from "#/lib/identity";

// Once-only and atomicity of Instance Setup itself are covered in instance-setup.db.test.ts
describe("Instance Setup from ADMIN_EMAIL/ADMIN_PASSWORD", () => {
	it("creates the Default Admin from the env vars", async () => {
		const calls: unknown[] = [];
		const setup = async (admin: unknown) => calls.push(admin) > 0;
		await bootstrapDefaultAdmin(
			{ ADMIN_EMAIL: "env@x.io", ADMIN_PASSWORD: "pw" },
			setup,
		);
		expect(calls).toEqual([{ email: "env@x.io", password: "pw" }]);
	});

	it("leaves setup to /setup when admin env vars are missing", async () => {
		const calls: unknown[] = [];
		const setup = async (admin: unknown) => calls.push(admin) > 0;
		await bootstrapDefaultAdmin({ ADMIN_EMAIL: "env@x.io" }, setup);
		expect(calls).toEqual([]);
	});
});

describe("polaris user", () => {
	// better-auth links to an existing same-email User only when emailVerified is true (config: auth.test.ts)
	it("may merge into an existing User only when email_verified=true", () => {
		const base = { sub: "s1", email: "m@x.io" };
		expect(polarisUser({ ...base, email_verified: true }).emailVerified).toBe(
			true,
		);
		expect(polarisUser({ ...base, email_verified: false }).emailVerified).toBe(
			false,
		);
		expect(polarisUser(base).emailVerified).toBe(false);
	});

	it("gives phone-only users a placeholder email and shows the phone", () => {
		const user = polarisUser({ sub: "s1", phone_number: "+8613800000000" });
		expect(user.email).toBe("s1@polaris.invalid");
		expect(user.emailVerified).toBe(false);
		expect(user.name).toBe("+8613800000000");
		expect(displayName(user)).toBe("+8613800000000");
	});

	it("shows email before phone", () => {
		const user = polarisUser({
			sub: "s1",
			email: "m@x.io",
			phone_number: "+8613800000000",
		});
		expect(user.name).toBe("m@x.io");
		expect(displayName(user)).toBe("m@x.io");
	});

	it("never shows the placeholder email", () => {
		expect(
			displayName({ email: "s1@polaris.invalid", phoneNumber: null }),
		).toBe("");
	});
});

describe("password login", () => {
	const cases = [
		// role, oidcConfigured, allowMemberPassword, allowed
		["admin", true, false, true],
		["admin", false, false, true],
		["user", true, false, false],
		["user", true, true, true],
		["user", false, false, true],
		["user", false, true, true],
	] as const;
	it.each(
		cases,
	)("%s with OIDC=%s, member switch=%s → %s", (role, oidcConfigured, allowMemberPassword, allowed) => {
		expect(
			canUsePassword({ role }, { oidcConfigured, allowMemberPassword }),
		).toBe(allowed);
	});
});
