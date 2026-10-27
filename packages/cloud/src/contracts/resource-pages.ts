import type { CloudResourceRef } from "./capabilities";

/** Eight alternate pages per Type, within the manifest's 200-Type budget. */
export const RESOURCE_PAGES_PER_TYPE = 8;
/** Like other manifest route declarations, page patterns are bounded short paths. */
export const RESOURCE_PAGE_MAX_LENGTH = 300;
export const RESOURCE_URL_MAX_LENGTH = 8_192;

type Part = { literal: string } | { capture: string };
type Pattern = { segments: Part[]; query: [string, Part][] };
const capture = /^:([a-zA-Z][a-zA-Z0-9_]*)$/;
const decode = (value: string): string => decodeURIComponent(value);
const part = (value: string): Part => {
  const match = capture.exec(value);
  if (match?.[1]) return { capture: match[1] };
  if (!value || value.includes(":")) throw new Error("Captures must occupy a whole segment or query value");
  const literal = decode(value);
  if (!literal || literal === "." || literal === ".." || /[\\/\u0000-\u001f]/.test(literal)) throw new Error("Invalid literal segment");
  return { literal };
};

const parsePattern = (path: string): Pattern => {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > RESOURCE_PAGE_MAX_LENGTH || /[\s#\\]/.test(path))
    throw new Error(`Expected a root-relative page pattern of at most ${RESOURCE_PAGE_MAX_LENGTH} characters`);
  const [pathname = "", search = "", extra] = path.split("?");
  if (extra !== undefined) throw new Error("Page patterns may contain only one query separator");
  const route = pathname.replace(/\/$/, "").slice(1);
  const segments = route ? route.split("/").map(part) : [];
  const keys = new Set<string>();
  const query: [string, Part][] = search
    ? search.split("&").map((entry) => {
        const [key = "", value, extraValue] = entry.split("=");
        if (!key || value === undefined || extraValue !== undefined) throw new Error("Expected query key=value");
        const decodedKey = decode(key.replace(/\+/g, " "));
        if (!decodedKey || decodedKey.includes(":") || keys.has(decodedKey)) throw new Error("Invalid or repeated query key");
        keys.add(decodedKey);
        return [decodedKey, part(value.replace(/\+/g, " "))];
      })
    : [];
  const parts = [...segments, ...query.map(([, value]) => value)];
  if (parts.filter((value) => "capture" in value && value.capture === "id").length !== 1)
    throw new Error("A page pattern must contain exactly one :id capture");
  return { segments, query };
};

/** Validates syntax and ownership; prefixes use the gateway's literal segment boundary. */
export const resourcePageIssue = (path: string, prefixes?: readonly string[], appId?: string): string | null => {
  try {
    const pattern = parsePattern(path);
    const namespace = pattern.segments[0];
    const owner = pattern.segments[1];
    if (
      appId &&
      namespace &&
      "literal" in namespace &&
      namespace.literal === "app" &&
      (!owner || !("literal" in owner) || owner.literal !== appId)
    )
      return "Only app <id> may declare pages below /app/<id>";
    if (
      prefixes &&
      !prefixes.some((prefix) => {
        if (prefix === "/") return true;
        if (!prefix.startsWith("/") || /[?#%\\:]/.test(prefix)) return false;
        const segments = prefix.replace(/\/$/, "").slice(1).split("/");
        return segments.every((value, index) => {
          const segment = pattern.segments[index];
          return segment && "literal" in segment && segment.literal === value;
        });
      })
    )
      return "Page pattern must lie under an application's declared route prefix";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid page pattern";
  }
};

export type CloudResourcePage = { type: string; path: string; prefixes: readonly string[] };

/** Required query keys outrank literal path segments. Equal best scores for different refs are ambiguous. */
export const matchCloudResourcePage = (path: string, pages: readonly CloudResourcePage[]): CloudResourceRef | null => {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > RESOURCE_URL_MAX_LENGTH || /[\s\\]/.test(path)) return null;
  try {
    const url = new URL(path, "https://cloud.invalid");
    const route = url.pathname.replace(/\/$/, "").slice(1);
    const segments = route ? route.split("/").map(decode) : [];
    // URLSearchParams silently repairs malformed escapes: validate before reading it.
    decode(url.search.replace(/\+/g, " "));
    if (segments.some((value) => !value)) return null;
    let best: { ref: CloudResourceRef; queries: number; literals: number } | undefined;
    let ambiguous = false;
    for (const page of pages) {
      if (resourcePageIssue(page.path, page.prefixes, page.type.split(".")[0])) continue;
      const pattern = parsePattern(page.path);
      if (segments.length !== pattern.segments.length) continue;
      let id: string | undefined;
      const matches = (part: Part, value: string | undefined): boolean => {
        if (!value) return false;
        if ("literal" in part) return part.literal === value;
        if (part.capture === "id") id = value;
        return true;
      };
      if (!pattern.segments.every((part, index) => matches(part, segments[index]))) continue;
      if (
        !pattern.query.every(([key, part]) => {
          const values = url.searchParams.getAll(key);
          return values.length === 1 && matches(part, values[0]);
        }) ||
        !id
      )
        continue;
      const ref = { type: page.type, id };
      const queries = pattern.query.length;
      const literals = pattern.segments.filter((part) => "literal" in part).length;
      if (!best || queries > best.queries || (queries === best.queries && literals > best.literals)) {
        best = { ref, queries, literals };
        ambiguous = false;
      } else if (queries === best.queries && literals === best.literals && (ref.type !== best.ref.type || ref.id !== best.ref.id)) {
        ambiguous = true;
      }
    }
    return best && !ambiguous ? best.ref : null;
  } catch {
    return null;
  }
};

/** No network activity: accept one local URL token and reject origin tricks before catalog lookup. */
export const localCloudResourceUrl = (text: string, origin: string | null): URL | null => {
  if (!text || text.length > RESOURCE_URL_MAX_LENGTH || /[\s\\\u0000-\u001f]/.test(text) || text.startsWith("//")) return null;
  try {
    const relative = text.startsWith("/");
    const url = relative ? new URL(text, origin ?? "https://cloud.invalid") : new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || (!relative && (!origin || url.origin !== origin))) return null;
    return url;
  } catch {
    return null;
  }
};
