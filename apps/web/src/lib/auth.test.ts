import { parseAdditionalUserInputFromProviderProfile } from "better-auth/db";
import { describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";
import { polarisUser } from "#/lib/identity";

describe("polaris sign-in", () => {
	it("stores the phone number of a new polaris user", () => {
		const { email, emailVerified, name, ...profile } = polarisUser({
			sub: "s1",
			phone_number: "+8613800000000",
		});
		expect(
			parseAdditionalUserInputFromProviderProfile(
				auth.options,
				profile,
				"create",
			),
		).toMatchObject({ phoneNumber: "+8613800000000" });
	});

	// better-auth merges into a same-email User only if this config holds and polarisUser says emailVerified
	it("merges into a same-email User on polaris' email_verified alone", () => {
		// Exact match: linking enabled, implicit linking allowed, the local User's own verification not
		// required, and no trustedProviders (a trusted polaris would merge even when email_verified=false)
		expect(auth.options.account).toEqual({
			accountLinking: { requireLocalEmailVerified: false },
		});
	});

	it("does not let users set their own phone number", async () => {
		await expect(
			auth.api.updateUser({
				body: { phoneNumber: "+8613800000000" },
				headers: new Headers(),
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});
});
