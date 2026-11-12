import { connections } from "../../runtime/connections";
/**
 * Encryption helpers for settings at-rest.
 *
 * Settings DB rows are encrypted via stdlib's `crypto.symmetric.encrypt`
 * (AES-256-GCM with HKDF key derivation). The key material comes from
 * `APP_SECRET` — see `getAppSecret()` for the hex/passphrase handling.
 */

import { appSecretRoots, normalizeAppSecret } from "../../runtime/app-secret";
import { crypto } from "../../server/services";

/** Current-root writers keep the legacy hex/passphrase normalization. */
export const getAppSecret = (): string => normalizeAppSecret(connections().appSecret.current);

/** Encrypt already-decrypted bytes without parsing or changing their representation. */
export const encryptSecretBytes = async (payload: string): Promise<string> =>
  crypto.symmetric.encrypt({ payload, key: getAppSecret(), stretched: false });

export const decryptSecretBytes = async (payload: string, root: string): Promise<string> =>
  crypto.symmetric.decrypt({ payload, key: normalizeAppSecret(root) });

export const decryptWithSecretRing = async (payload: string): Promise<{ plaintext: string; rootIndex: number }> => {
  const roots = appSecretRoots(connections().appSecret);
  for (const [rootIndex, root] of roots.entries()) {
    try {
      return { plaintext: await decryptSecretBytes(payload, root), rootIndex };
    } catch {
      /* AES-GCM authentication selects the matching root. */
    }
  }
  throw new Error("Encrypted value cannot be read with the configured APP_SECRET ring");
};

export const encryptValue = async (value: unknown): Promise<string> => encryptSecretBytes(JSON.stringify(value));

export const decryptValue = async (value: string): Promise<unknown> => {
  const { plaintext } = await decryptWithSecretRing(value);
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
};
