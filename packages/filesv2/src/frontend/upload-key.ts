// Filegate's maximum open lifetime plus its terminal receipt retention.
export const UPLOAD_KEY_RETENTION_MS = (24 + 7 * 24) * 60 * 60 * 1000;
const keyPrefix = "filesv2:upload:";
// The start time lives next to the key, so tabs still running an older client keep reading a bare UUID.
const atPrefix = "filesv2:upload-at:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const touch = (hash: string, now: number) => {
  try {
    localStorage.setItem(atPrefix + hash, String(now));
  } catch {}
};

/**
 * Drops keys whose latest start is older than Filegate can still know about. A key without a readable time counts
 * as started now, which may keep it longer but never prunes it early; a full storage leaves it for the next start.
 */
function uploadKeys(now: number) {
  const entries = new Map<string, string>();
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (key?.startsWith(atPrefix)) {
      if (localStorage.getItem(keyPrefix + key.slice(atPrefix.length)) === null) localStorage.removeItem(key);
      continue;
    }
    if (!key?.startsWith(keyPrefix)) continue;
    const hash = key.slice(keyPrefix.length);
    const value = localStorage.getItem(key);
    const at = Number(localStorage.getItem(atPrefix + hash) ?? Number.NaN);
    if (value && uuid.test(value) && !(now - at > UPLOAD_KEY_RETENTION_MS)) {
      if (!Number.isFinite(at)) touch(hash, now);
      entries.set(hash, value);
      continue;
    }
    localStorage.removeItem(key);
    localStorage.removeItem(atPrefix + hash);
  }
  return entries;
}

/** Keep a logical start key across reloads/lost responses, without storing names, paths or share tokens. */
export async function browserUploadKey(scope: readonly unknown[], file: Blob) {
  const metadata = [scope, file.size, file.type, "name" in file ? file.name : null, "lastModified" in file ? file.lastModified : null];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(metadata))));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const stored = uploadKeys(now).get(hash);
  const idempotencyKey = stored ?? crypto.randomUUID();
  // Failure must happen before issuance; an in-memory fallback would lose the durable guarantee.
  if (!stored) localStorage.setItem(keyPrefix + hash, idempotencyKey);
  // Retention counts from the latest start, which a session created by this start can never predate.
  touch(hash, now);
  return {
    idempotencyKey,
    finish: () => {
      localStorage.removeItem(keyPrefix + hash);
      localStorage.removeItem(atPrefix + hash);
    },
  };
}
