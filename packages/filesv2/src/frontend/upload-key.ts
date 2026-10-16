// Filegate's maximum open lifetime plus its terminal receipt retention.
export const UPLOAD_KEY_RETENTION_MS = (24 + 7 * 24) * 60 * 60 * 1000;
const prefix = "filesv2:upload:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uploadKeys(now: number) {
  const entries = new Map<string, string>();
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    const value = localStorage.getItem(key);
    if (value && uuid.test(value)) {
      // Counting a legacy key as created now never prunes it early; a full storage keeps the bare value for the next start.
      try {
        localStorage.setItem(key, JSON.stringify({ id: value, at: now }));
      } catch {}
      entries.set(key, value);
      continue;
    }
    try {
      const entry: unknown = JSON.parse(value ?? "null");
      if (
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string" &&
        uuid.test(entry.id) &&
        "at" in entry &&
        typeof entry.at === "number" &&
        Number.isFinite(entry.at) &&
        now - entry.at <= UPLOAD_KEY_RETENTION_MS
      ) {
        entries.set(key, entry.id);
        continue;
      }
    } catch {}
    localStorage.removeItem(key);
  }
  return entries;
}

/** Keep a logical start key across reloads/lost responses, without storing names, paths or share tokens. */
export async function browserUploadKey(scope: readonly unknown[], file: Blob) {
  const metadata = [scope, file.size, file.type, "name" in file ? file.name : null, "lastModified" in file ? file.lastModified : null];
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(metadata))));
  const storageKey = `filesv2:upload:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const now = Date.now();
  const stored = uploadKeys(now).get(storageKey);
  const idempotencyKey = stored ?? crypto.randomUUID();
  const entry = JSON.stringify({ id: idempotencyKey, at: now });
  // Failure must happen before issuance; an in-memory fallback would lose the durable guarantee.
  if (!stored) localStorage.setItem(storageKey, entry);
  else
    try {
      // Retention counts from the latest start, which a session created by this start can never predate.
      localStorage.setItem(storageKey, entry);
    } catch {}
  return { idempotencyKey, finish: () => localStorage.removeItem(storageKey) };
}
