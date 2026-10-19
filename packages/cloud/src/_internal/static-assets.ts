import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Context } from "hono";

const publicRoot = resolve(process.cwd(), "public");
const versions = new Map<string, string>();

/**
 * Version of Core's shared stylesheets: the release, which names one build. `local` and `development` are the
 * defaults of unnamed builds and name many, so those sheets get no version and are revalidated instead.
 */
export function sharedStylesheetVersion(release: string | undefined): string | undefined {
  return !release || release === "local" || release === "development" ? undefined : release;
}

/**
 * Content version of a file below `public/`: hashed on first use and kept for the process, since production files
 * never change under a running process. An unreadable file has no version and is tried again on the next call.
 */
export function publicFileVersion(pathname: string): string | undefined {
  const path = resolvePublicAsset(pathname);
  if (!path) return undefined;
  const cached = versions.get(path);
  if (cached) return cached;
  try {
    const version = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    versions.set(path, version);
    return version;
  } catch {
    return undefined;
  }
}

/** Append a URL-encoded version only when the asset has one. */
export function versionedPublicHref(pathname: string, version: string | undefined): string {
  return version === undefined ? pathname : `${pathname}?v=${encodeURIComponent(version)}`;
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function resolvePublicAsset(pathname: string): string | null {
  const decoded = decodePathname(pathname);
  if (!decoded?.startsWith("/public/")) return null;

  const path = resolve(process.cwd(), decoded.slice(1));
  if (path !== publicRoot && !path.startsWith(`${publicRoot}${sep}`)) return null;
  return path;
}

function acceptsEncoding(header: string | null, encoding: "br" | "gzip"): boolean {
  if (!header) return false;

  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== encoding) return false;
    return !params.some((param) => {
      const [key, value] = param.trim().split("=");
      return key?.toLowerCase() === "q" && Number(value) === 0;
    });
  });
}

/** `If-None-Match` names the current file: a list of tags, possibly weak, or `*`. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

async function encodedFile(path: string, encoding: "br" | "gzip"): Promise<Bun.BunFile | null> {
  const suffix = encoding === "br" ? ".br" : ".gz";
  const file = Bun.file(`${path}${suffix}`);
  return (await file.exists()) ? file : null;
}

export function servePublicAsset(isDevelopment: boolean, sharedVersion?: string) {
  return async (c: Context) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("Allow", "GET, HEAD");
      return c.text("Method Not Allowed", 405);
    }

    const url = new URL(c.req.url);
    const path = resolvePublicAsset(url.pathname);
    if (!path) return c.notFound();

    const sourceFile = Bun.file(path);
    if (!(await sourceFile.exists())) return c.notFound();

    const acceptEncoding = c.req.header("Accept-Encoding") ?? null;
    let selected = sourceFile;
    let selectedEncoding: "br" | "gzip" | null = null;

    if (acceptsEncoding(acceptEncoding, "br")) {
      const br = await encodedFile(path, "br");
      if (br) {
        selected = br;
        selectedEncoding = "br";
      }
    }

    if (!selectedEncoding && acceptsEncoding(acceptEncoding, "gzip")) {
      const gz = await encodedFile(path, "gzip");
      if (gz) {
        selected = gz;
        selectedEncoding = "gzip";
      }
    }

    // Development rebuilds files in place under the same address, so the browser asks again on every use; an
    // unchanged file then costs one round trip instead of its whole size on every page.
    const etag = `"${selectedEncoding ?? "identity"}-${selected.size.toString(36)}-${selected.lastModified.toString(36)}"`;
    // The page head links these files with the version this process names for them. Any other version may name
    // other content (a rolling deploy, an app started before a Core redeploy), so it is revalidated, never kept.
    let cacheControl = isDevelopment ? "no-cache" : "public, max-age=31536000, immutable";
    if (!isDevelopment) {
      const pathname = decodePathname(url.pathname)!;
      const shared = /^\/public\/(fonts|tabler-icons|global)\.css$/.test(pathname);
      const own = /^\/public\/[^/]+\/(app\.css|favicon\.svg)$/.test(pathname);
      if (shared || own) {
        const expected = shared ? sharedVersion : publicFileVersion(url.pathname);
        if (expected === undefined || url.searchParams.get("v") !== expected) cacheControl = "no-cache";
      }
    }
    const headers = new Headers({
      "Cache-Control": cacheControl,
      ETag: etag,
      Vary: "Accept-Encoding",
    });

    if (matchesEtag(c.req.header("If-None-Match") ?? null, etag)) return new Response(null, { status: 304, headers });

    headers.set("Content-Length", String(selected.size));
    headers.set("Content-Type", sourceFile.type || "application/octet-stream");
    if (selectedEncoding) headers.set("Content-Encoding", selectedEncoding);

    return new Response(c.req.method === "HEAD" ? null : selected, { headers });
  };
}
