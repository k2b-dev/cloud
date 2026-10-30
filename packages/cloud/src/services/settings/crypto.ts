import { connections } from "../../runtime/connections";
/**
 * Encryption helpers for settings at-rest.
 *
 * Settings DB rows are encrypted via stdlib's `crypto.symmetric.encrypt`
 * (AES-256-GCM with HKDF key derivation). The key material comes from
 * `APP_SECRET` — see `getAppSecret()` for the hex/passphrase handling.
 */

import { createHash } from "node:crypto";
import { crypto } from "../../server/services";

/**
 * Resolve the encryption key passed to stdlib's `crypto.symmetric.encrypt`.
 *
 * Stdlib derives keys via HKDF and requires the input to be a hex string
 * (it calls `fromHex(key)` internally). Two cases:
 *
 *  1. APP_SECRET is already a valid hex string (any even length).
 *     Pass it through unchanged. THIS IS THE PRODUCTION PATH — existing
 *     deployments use hex secrets and have data encrypted with the secret
 *     verbatim. Any transformation here would change the derived HKDF key
 *     and make every previously encrypted settings row unreadable.
 *
 *  2. APP_SECRET is not valid hex (e.g. a passphrase like "supersecret").
 *     Deterministically derive a 32-byte hex key via SHA-256. Same input
 *     always produces the same hex output, so settings encrypted with a
 *     non-hex secret stay decryptable across restarts.
 *
 * ⚠️  DO NOT change the hex-passthrough branch. Hashing a hex secret would
 * silently break every prod instance: encrypted settings could no longer
 * be decrypted because the HKDF input would differ from what was used at
 * write time. The branch exists specifically to preserve backward compat
 * with deployments that have always used hex-format APP_SECRET.
 */
export const getAppSecret = (): string => {
  const raw = connections().appSecret.current.trim();
  if (!raw) {
    throw new Error("APP_SECRET is required to read or write encrypted settings");
  }
  // Case 1: already hex — pass through (backward-compat, see doc above).
  if (raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw)) {
    return raw;
  }
  // Case 2: non-hex passphrase — deterministically derive hex via SHA-256.
  return createHash("sha256").update(raw).digest("hex");
};

export const encryptValue = async (value: unknown): Promise<string> =>
  crypto.symmetric.encrypt({
    payload: JSON.stringify(value),
    key: getAppSecret(),
    stretched: false,
  });

export const decryptValue = async (value: string): Promise<unknown> => {
  const decrypted = await crypto.symmetric.decrypt({
    payload: value,
    key: getAppSecret(),
  });
  try {
    return JSON.parse(decrypted);
  } catch {
    // Decrypt succeeded but the plaintext isn't JSON. Either pre-JSON-encoding
    // legacy data or external write — return the raw string so callers can
    // decide. Throwing here would corrupt the read path entirely.
    return decrypted;
  }
};
