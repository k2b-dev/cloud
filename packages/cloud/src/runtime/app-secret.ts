import { createHash, createHmac } from "node:crypto";
import type { PlatformConnectionValues } from "./connections";

export type AppSecretRing = PlatformConnectionValues["appSecret"];

/** Preserve the encryption key normalization used by every existing ciphertext. */
export const normalizeAppSecret = (secret: string): string => {
  const raw = secret.trim();
  if (!raw) throw new Error("APP_SECRET is required to read or write encrypted settings");
  return raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw) ? raw : createHash("sha256").update(raw).digest("hex");
};

/** Only this opaque fingerprint belongs in metadata; never publish key material. */
export const appSecretRootId = (root: string): string =>
  createHmac("sha256", root).update("cloud:app-secret:root-id").digest("base64url").slice(0, 16);

export const appSecretRoots = (ring: AppSecretRing): string[] =>
  [ring.current, ring.previous, ring.next].filter((root): root is string => root !== undefined);

export const appSecretRingId = (ring: AppSecretRing): string =>
  JSON.stringify([
    appSecretRootId(ring.current),
    ring.previous ? appSecretRootId(ring.previous) : null,
    ring.next ? appSecretRootId(ring.next) : null,
  ]);

export const validateAppSecretRing = (ring: AppSecretRing): void => {
  if (ring.previous !== undefined && ring.next !== undefined)
    throw new Error("APP_SECRET_NEXT and APP_SECRET_PREVIOUS must not both be set");
  if (ring.next !== undefined && !/^[0-9a-fA-F]{64}$/.test(ring.next))
    throw new Error("APP_SECRET_NEXT must contain 64 hex characters (32 random bytes)");
  if (ring.previous !== undefined || ring.next !== undefined) {
    const roots = appSecretRoots(ring);
    const normalized = roots.map((root) => normalizeAppSecret(root).toLowerCase());
    if (new Set(roots).size !== roots.length || new Set(normalized).size !== normalized.length)
      throw new Error("APP_SECRET rotation roots must be distinct");
  }
};
