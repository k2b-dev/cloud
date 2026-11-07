import { decryptValue, encryptValue, getAppSecret } from "./crypto";
import { SETTINGS, SETTINGS_MAP, validateSettingValue } from "./defaults";

export const SECRET_CACHE_FORMAT = "v2";
export const ENCRYPTED_SETTING_PREFIX = `!cloud:encrypted-setting:${SECRET_CACHE_FORMAT}:`;
const decoded = new Map<string, { key: string; value: unknown }>();
let secret: string | undefined;

export const encodeSecretCache = async (key: string, value: unknown): Promise<string> =>
  ENCRYPTED_SETTING_PREFIX + (await encryptValue({ k: key, v: value }));

/** Reuse validated ciphertext only while this process has the same encryption key. */
export const readSecretCache = async (key: string, ciphertext: string): Promise<unknown> => {
  const current = getAppSecret();
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
  if (!envelope || typeof envelope !== "object" || !("k" in envelope) || envelope.k !== key || !("v" in envelope))
    throw new Error("Setting cache key mismatch");
  const def = SETTINGS_MAP.get(key);
  if (!def || def.kind !== "secret") throw new Error("Unknown secret setting");
  const validated = validateSettingValue(def, envelope.v);
  if (!validated.ok) throw new Error("Invalid secret cache entry");
  decoded.set(ciphertext, { key, value: validated.value });
  // One slot per declared secret setting; previous ciphertexts leave in LRU order.
  const limit = SETTINGS.filter((setting) => setting.kind === "secret").length;
  while (decoded.size > limit) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) break;
    decoded.delete(oldest);
  }
  return validated.value;
};
