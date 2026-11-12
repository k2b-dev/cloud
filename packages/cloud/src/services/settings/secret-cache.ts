import { appSecretRingId } from "../../runtime/app-secret";
import { connections } from "../../runtime/connections";
import { decryptValue, encryptValue } from "./crypto";
import { SETTINGS, SETTINGS_MAP, validateSettingValue } from "./defaults";

export const SECRET_CACHE_FORMAT = "v3";
export const ENCRYPTED_SETTING_PREFIX = `!cloud:encrypted-setting:${SECRET_CACHE_FORMAT}:`;
const decoded = new Map<string, { key: string; value: unknown }>();
let secret: string | undefined;

export const encodeSecretCache = async (key: string, value: unknown): Promise<string> =>
  ENCRYPTED_SETTING_PREFIX + (await encryptValue({ k: key, v: value, ring: appSecretRingId(connections().appSecret) }));

/** Reuse validated ciphertext only while this process has the same complete secret ring. */
export const readSecretCache = async (key: string, ciphertext: string): Promise<unknown> => {
  const current = appSecretRingId(connections().appSecret);
  if (current !== secret) {
    decoded.clear();
    secret = current;
  }
  const cached = decoded.get(ciphertext);
  if (cached) {
    if (cached.key !== key) throw new Error("Setting cache key mismatch");
    decoded.delete(ciphertext);
    decoded.set(ciphertext, cached);
    return cached.value;
  }
  if (!ciphertext.startsWith(ENCRYPTED_SETTING_PREFIX)) throw new Error("Unsupported setting cache format");
  const envelope = await decryptValue(ciphertext.slice(ENCRYPTED_SETTING_PREFIX.length));
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("k" in envelope) ||
    envelope.k !== key ||
    !("v" in envelope) ||
    !("ring" in envelope) ||
    envelope.ring !== current
  )
    throw new Error("Setting cache key mismatch");
  const def = SETTINGS_MAP.get(key);
  const validated = def ? validateSettingValue(def, envelope.v) : { ok: true as const, value: envelope.v };
  if (!validated.ok) throw new Error("Invalid secret cache entry");
  decoded.set(ciphertext, { key, value: validated.value });
  // One slot per declared setting; previous ciphertexts leave in LRU order.
  const limit = SETTINGS.length;
  while (decoded.size > limit) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) break;
    decoded.delete(oldest);
  }
  return validated.value;
};
