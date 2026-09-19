/** A file entry has no server-side id; the ref encodes base and path so both sides can rebuild it. */
const encode = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const decode = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
};
export const ENTRY_TYPE = "filesv2.entry";
export function entryRefId(baseId: string, path: string): string | null {
  const id = encode(`${baseId}\n${path}`);
  return id.length <= 512 ? id : null;
}
export function parseEntryRefId(id: string): { baseId: string; path: string } | null {
  try {
    if (!id || id.length > 512 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const decoded = decode(id);
    if (encode(decoded) !== id) return null;
    const [baseId, ...rest] = decoded.split("\n");
    return baseId && rest.length ? { baseId, path: rest.join("\n") } : null;
  } catch {
    return null;
  }
}
