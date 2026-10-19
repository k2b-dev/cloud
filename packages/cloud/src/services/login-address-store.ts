import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requestCacheRedis } from "./request-cache-redis";

const AddressProofSchema = z.object({ salt: z.string().regex(/^[a-f0-9]{32}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AppLoginAddressProof = z.infer<typeof AddressProofSchema>;
export type AppLoginAddressStore = {
  remember(requestId: string, proof: AppLoginAddressProof, expiresAt: Date): Promise<void>;
  read(requestIds: string[]): Promise<Map<string, AppLoginAddressProof>>;
  forget(requestId: string): Promise<void>;
};
export const appLoginAddressKey = (requestId: string) => `cloud:app-login-address:${requestId}`;
const digest = (salt: string, prefix: string) => new Bun.CryptoHasher("sha256").update(Buffer.from(salt, "hex")).update(prefix).digest();
export const appLoginAddressProof = (prefix: string): AppLoginAddressProof => {
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  return { salt, digest: digest(salt, prefix).toString("hex") };
};
export const appLoginAddressMatches = (proof: AppLoginAddressProof, prefix: string): boolean => {
  const parsed = AddressProofSchema.safeParse(proof);
  return parsed.success && timingSafeEqual(Buffer.from(parsed.data.digest, "hex"), digest(parsed.data.salt, prefix));
};

/** Fail-fast cache client; service callers catch every failure after their SQL commit. */
export const valkeyAppLoginAddressStore: AppLoginAddressStore = {
  remember: async (requestId, proof, expiresAt) => {
    await (await requestCacheRedis()).send("SET", [
      appLoginAddressKey(requestId),
      JSON.stringify(proof),
      "PXAT",
      String(expiresAt.getTime()),
    ]);
  },
  read: async (requestIds) => {
    const proofs = new Map<string, AppLoginAddressProof>();
    if (!requestIds.length) return proofs;
    const values = await (await requestCacheRedis()).mget(...requestIds.map(appLoginAddressKey));
    for (const [index, value] of values.entries()) {
      if (!value) continue;
      try {
        const parsed = AddressProofSchema.safeParse(JSON.parse(value));
        if (parsed.success) proofs.set(requestIds[index]!, parsed.data);
      } catch {
        // Invalid cache entries are absent hints, never sign-in failures.
      }
    }
    return proofs;
  },
  forget: async (requestId) => {
    await (await requestCacheRedis()).del(appLoginAddressKey(requestId));
  },
};
