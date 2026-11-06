import { describe, expect, it } from "vitest";
import { ADMIN_ENTITLEMENT, toUser } from "#/lib/identity";

describe("signed-in User", () => {
	it("is keyed by the Polaris sub", () => {
		expect(toUser({ sub: "s1" }, []).id).toBe("s1");
	});

	it("is an Admin only with the admin Entitlement", () => {
		expect(toUser({ sub: "s1" }, [ADMIN_ENTITLEMENT]).admin).toBe(true);
		expect(toUser({ sub: "s1" }, ["orqestra:other"]).admin).toBe(false);
		expect(toUser({ sub: "s1" }, []).admin).toBe(false);
	});

	it("shows email, then phone, then name, then sub", () => {
		const claims = {
			sub: "s1",
			email: "m@x.io",
			phone_number: "+8613800000000",
			name: "M",
		};
		expect(toUser(claims, []).name).toBe("m@x.io");
		expect(toUser({ ...claims, email: "" }, []).name).toBe("+8613800000000");
		expect(toUser({ sub: "s1", name: "M" }, []).name).toBe("M");
		expect(toUser({ sub: "s1" }, []).name).toBe("s1");
	});
});
