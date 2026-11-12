import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The AES-256 key from ORQESTRA_ENCRYPTION_KEY (`openssl rand -base64 32`); throws when it is missing or malformed. */
export function encryptionKey(
	value = process.env.ORQESTRA_ENCRYPTION_KEY,
): Buffer {
	if (!value)
		throw new Error(
			"ORQESTRA_ENCRYPTION_KEY is not set; generate one with `openssl rand -base64 32`",
		);
	const key = Buffer.from(value, "base64");
	if (key.length !== 32)
		throw new Error("ORQESTRA_ENCRYPTION_KEY must be 32 bytes of base64");
	return key;
}

/** AES-256-GCM, stored as base64 of iv (12) + auth tag (16) + ciphertext. */
export function encryptSecret(plain: string, key = encryptionKey()) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

/** Undefined when the secret was encrypted with another key (or is corrupt). */
export function decryptSecret(stored: string, key = encryptionKey()) {
	const raw = Buffer.from(stored, "base64");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		return Buffer.concat([
			decipher.update(raw.subarray(28)),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return undefined;
	}
}

/** What to store for a secret typed into a form: it encrypted, or the stored one when it was left blank. */
export const sealSecret = (typed: string | undefined, stored?: string) =>
	typed ? encryptSecret(typed) : stored;

/** False once ORQESTRA_ENCRYPTION_KEY changed: the Admin must enter it again. */
export const secretReadable = (stored: string) =>
	decryptSecret(stored) !== undefined;
