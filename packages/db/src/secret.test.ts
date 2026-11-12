import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptionKey, encryptSecret } from "./secret";

const key = () => randomBytes(32).toString("base64");

describe("API key encryption", () => {
	it("decrypts what it encrypted, without storing the plain text", () => {
		const k = encryptionKey(key());
		const stored = encryptSecret("sk-secret", k);
		expect(stored).not.toContain("sk-secret");
		expect(decryptSecret(stored, k)).toBe("sk-secret");
	});

	it("reads nothing back once ORQESTRA_ENCRYPTION_KEY changed", () => {
		const stored = encryptSecret("sk-secret", encryptionKey(key()));
		expect(decryptSecret(stored, encryptionKey(key()))).toBeUndefined();
	});

	it("rejects a key that is not 32 bytes of base64", () => {
		expect(() => encryptionKey("")).toThrow(/ORQESTRA_ENCRYPTION_KEY/);
		expect(() => encryptionKey("c2hvcnQ=")).toThrow(/32 bytes/);
	});
});
