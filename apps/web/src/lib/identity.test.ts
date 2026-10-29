import { describe, expect, it } from "vitest";
import {
	bootstrapDefaultAdmin,
	canUsePassword,
	displayName,
	polarisUser,
	setupInstance,
} from "./identity";

function fakeAdmins() {
	const admins: string[] = [];
	return {
		admins,
		hasAdmin: async () => admins.length > 0,
		createAdmin: async (email: string) => {
			admins.push(email);
		},
	};
}

describe("Instance Setup", () => {
	it("creates the Default Admin from /setup only once", async () => {
		const store = fakeAdmins();
		expect(
			await setupInstance(store, { email: "a@x.io", password: "pw" }),
		).toBe(true);
		expect(
			await setupInstance(store, { email: "b@x.io", password: "pw" }),
		).toBe(false);
		expect(store.admins).toEqual(["a@x.io"]);
	});

	it("creates the Default Admin from ADMIN_EMAIL/ADMIN_PASSWORD only once", async () => {
		const store = fakeAdmins();
		const env = { ADMIN_EMAIL: "env@x.io", ADMIN_PASSWORD: "pw" };
		await bootstrapDefaultAdmin(env, store);
		await bootstrapDefaultAdmin(env, store);
		expect(store.admins).toEqual(["env@x.io"]);
		expect(
			await setupInstance(store, { email: "b@x.io", password: "pw" }),
		).toBe(false);
	});

	it("leaves setup to /setup when admin env vars are missing", async () => {
		const store = fakeAdmins();
		await bootstrapDefaultAdmin({ ADMIN_EMAIL: "env@x.io" }, store);
		expect(store.admins).toEqual([]);
	});
});

describe("polaris user", () => {
	// better-auth links to an existing same-email User only when emailVerified is true
	it("may merge into an existing account only when email_verified=true", () => {
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
		expect(canUsePassword(role, { oidcConfigured, allowMemberPassword })).toBe(
			allowed,
		);
	});
});
