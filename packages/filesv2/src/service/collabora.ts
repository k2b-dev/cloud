import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@k2b/cloud/config";
import { z } from "zod";
import { FilesError } from "./errors";

/**
 * Editor tokens let Collabora call the WOPI routes on behalf of one user for one file. They carry no
 * rights: every WOPI call resolves the user and the current permissions again, so an instance that never
 * saw the editor start can answer, and revoked access ends the session at the next call.
 */
const TokenPayloadSchema = z.object({ u: z.string().uuid(), b: z.string().min(1), p: z.string().min(1), e: z.number().int() }).strict();
export type EditorTokenPayload = { userId: string; baseId: string; path: string; expiresAt: number };
const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (body: string) => createHmac("sha256", env.APP_SECRET).update(`filesv2.editor:${body}`).digest("base64url");

export function signEditorToken(payload: EditorTokenPayload): string {
  const body = encode(JSON.stringify({ u: payload.userId, b: payload.baseId, p: payload.path, e: payload.expiresAt }));
  return `${body}.${sign(body)}`;
}
export function verifyEditorToken(token: string, now = Date.now()): EditorTokenPayload | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length || token.length > 4096) return null;
  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const parsed = TokenPayloadSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString()));
    if (parsed.e <= now) return null;
    return { userId: parsed.u, baseId: parsed.b, path: parsed.p, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

/**
 * Collabora publishes one editor URL per extension and action in `/hosting/discovery`. The document is
 * configuration, not state: each process caches it briefly and re-reads it on its own.
 */
export type DiscoveryAction = "edit" | "view";
export type Discovery = Map<string, Partial<Record<DiscoveryAction, string>>>;
export const DISCOVERY_CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { fetchedAt: number; actions: Discovery }>();

export function parseDiscovery(xml: string): Discovery {
  const actions: Discovery = new Map();
  for (const tag of xml.matchAll(/<action\b([^>]*)\/?>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[1]!.matchAll(/(\w+)="([^"]*)"/g)) attributes.set(attribute[1]!, attribute[2]!);
    const ext = attributes.get("ext");
    const name = attributes.get("name");
    const urlsrc = attributes.get("urlsrc");
    if (!ext || !urlsrc || (name !== "edit" && name !== "view")) continue;
    const entry = actions.get(ext.toLowerCase()) ?? {};
    entry[name] = urlsrc;
    actions.set(ext.toLowerCase(), entry);
  }
  return actions;
}

/** Collabora reports itself under the host it was asked through; the browser-facing origin replaces it. */
export async function discoverEditor(
  options: { url: string; internalUrl: string; extension: string; action: DiscoveryAction },
  transfer: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const source = options.internalUrl || options.url;
  let known = cache.get(source);
  if (!known || now - known.fetchedAt > DISCOVERY_CACHE_MS) {
    let xml: string;
    try {
      const response = await transfer(`${source.replace(/\/$/, "")}/hosting/discovery`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(response.statusText);
      xml = await response.text();
    } catch {
      throw new FilesError("editor_unavailable", 503);
    }
    known = { fetchedAt: now, actions: parseDiscovery(xml) };
    cache.set(source, known);
  }
  const entry = known.actions.get(options.extension);
  const urlsrc = entry?.[options.action] ?? entry?.edit;
  if (!urlsrc) throw new FilesError("editor_unsupported", 400);
  const target = new URL(urlsrc);
  const publicOrigin = new URL(options.url);
  target.protocol = publicOrigin.protocol;
  target.hostname = publicOrigin.hostname;
  target.port = publicOrigin.port;
  return target.href;
}
export const resetDiscoveryCache = () => cache.clear();

/** Collabora stores LastModifiedTime at microsecond precision; Date alone loses it. */
export function wopiTimestamp(value: string): string {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return "";
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(milliseconds)) return "";
  return `${new Date(milliseconds).toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(6, "0").slice(0, 6)}Z`;
}
