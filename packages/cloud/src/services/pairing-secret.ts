import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Shared by Cloud Login and mobile app pairing: secrets are stored only as SHA-256 hex. */
export const pairingSecret = {
  /** 32 random bytes, base64url without padding (43 characters). */
  create: (): string => randomBytes(32).toString("base64url"),
  hash: (value: string): string => createHash("sha256").update(value).digest("hex"),
  /** Timing-safe comparison of a presented secret with a stored hash. */
  matches: (value: string, expectedHash: string): boolean => {
    const expected = Buffer.from(expectedHash, "hex");
    const actual = Buffer.from(pairingSecret.hash(value), "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  },
  /** A six-digit code with leading zeros. */
  code: (): string => String(randomInt(0, 1_000_000)).padStart(6, "0"),
};
