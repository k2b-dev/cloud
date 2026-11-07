import { createHash, randomBytes } from "node:crypto";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Exactly 128 random bits, padded to 22 Base62 digits. No modulo bias. */
export const randomId = (): string => {
  let number = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let token = "";
  while (number > 0n) {
    token = alphabet[Number(number % 62n)] + token;
    number /= 62n;
  }
  return token.padStart(22, "0");
};
export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const validId = (value: string): boolean => /^[0-9A-Za-z]{22}$/.test(value);
