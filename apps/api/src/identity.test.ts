import { describe, expect, it } from "bun:test";
import { ADMIN_ENTITLEMENT, toUser } from "./identity.ts";

describe("signed-in User", () => {
	it("is keyed by the Polaris sub", () => {
		expect(toUser({ sub: "s1" }, []).id).toBe("s1");
	});

	it("is an Admin only with the admin Entitlement", () => {
		expect(toUser({ sub: "s1" }, [ADMIN_ENTITLEMENT]).admin).toBe(true);
		expect(toUser({ sub: "s1" }, ["orqestra:other"]).admin).toBe(false);
		expect(toUser({ sub: "s1" }, []).admin).toBe(false);
	});

	it("shows name, nickname, username, email, phone, then sub", () => {
		const claims = {
			sub: "s1",
			name: "Ada Lovelace",
			nickname: "Ada",
			preferred_username: "ada",
			email: "m@x.io",
			phone_number: "+8613800000000",
		};
		const without = (...keys: string[]) =>
			toUser(
				Object.fromEntries(
					Object.entries(claims).filter(([k]) => !keys.includes(k)),
				) as typeof claims,
				[],
			).name;
		expect(without()).toBe("Ada Lovelace");
		expect(toUser({ ...claims, name: "" }, []).name).toBe("Ada");
		expect(without("name", "nickname")).toBe("ada");
		expect(without("name", "nickname", "preferred_username")).toBe("m@x.io");
		expect(without("name", "nickname", "preferred_username", "email")).toBe(
			"+8613800000000",
		);
		expect(toUser({ sub: "s1" }, []).name).toBe("s1");
	});

	it("carries the email, when Polaris sends one", () => {
		expect(toUser({ sub: "s1", email: "m@x.io" }, []).email).toBe("m@x.io");
		expect(toUser({ sub: "s1", email: "" }, []).email).toBeUndefined();
	});
});
