/**
 * `filesv2.entry` ref forms. A path ref (inline, below, or a persisted `p:<sha256>` one for long paths) encodes
 * base and path, so a rename or move changes it. On roots with Filegate stable IDs the server mints
 * `n:<baseId>:<fileId>` instead, which keeps naming the same file across rename and move. Base64url has no
 * colon, so the forms never collide.
 */
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

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STABLE_REF = new RegExp(`^n:((?:cloud|freeipa):(?:users|groups):${UUID}):(${UUID})$`);
export function parseStableEntryRefId(id: string): { baseId: string; fileId: string } | null {
  const match = STABLE_REF.exec(id);
  return match ? { baseId: match[1]!, fileId: match[2]! } : null;
}
/** Only canonical forms are minted, so every stable ref Cloud hands out also parses. */
export function stableEntryRefId(baseId: string, fileId: string): string | null {
  const id = `n:${baseId}:${fileId}`;
  return parseStableEntryRefId(id) ? id : null;
}
