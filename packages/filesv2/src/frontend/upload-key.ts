/** Keep a logical start key across reloads/lost responses, without storing names, paths or share tokens. */
export async function browserUploadKey(scope: readonly unknown[], file: Blob) {
  const metadata = [scope, file.size, file.type, "name" in file ? file.name : null, "lastModified" in file ? file.lastModified : null];
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(metadata))));
  const storageKey = `filesv2:upload:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const stored = localStorage.getItem(storageKey);
  const idempotencyKey = stored ?? crypto.randomUUID();
  // Failure must happen before issuance; an in-memory fallback would lose the durable guarantee.
  if (!stored) localStorage.setItem(storageKey, idempotencyKey);
  return { idempotencyKey, finish: () => localStorage.removeItem(storageKey) };
}
