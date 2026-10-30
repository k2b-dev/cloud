import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Hono } from "hono";
import type { HttpOptions, NotesBindings } from "./app";
import { NotesError } from "./errors";
import { requestIp } from "./limits";
import { linkMetadata, Previews } from "./preview";
import type { NotesService } from "./service";

/** Enumerate build outputs once: a request path never becomes a filesystem path. */
export const mountWebsite = async (
  app: Hono<{ Bindings: NotesBindings }>,
  service: NotesService,
  options: HttpOptions,
  directory: string,
  maxCached: number,
) => {
  const index = await Bun.file(join(directory, "index.html")).text();
  const assets = new Map<string, ReturnType<typeof Bun.file>>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(directory, path);
    if (name === "index.html" || name.endsWith(".map")) continue;
    assets.set(`/${name}`, Bun.file(path));
  }
  const previews = new Previews(maxCached);
  const ip = (c: { env: NotesBindings; req: { header: (name: string) => string | undefined } }) =>
    requestIp(c.env?.peerIp, c.req.header("x-forwarded-for") ?? null, options.trustedProxy);
  app.get("/p/:id/preview.png", async (c) => {
    const readId = c.req.param("id");
    const current = await service.read(readId, ip(c));
    if (current.role !== "read") throw new NotesError("not_found", 404);
    if (c.req.method === "HEAD") return c.body(null, 200, { "Content-Type": "image/png" });
    return new Response(Uint8Array.from(await previews.get(current.readId, current.content)).buffer, {
      headers: { "Content-Type": "image/png" },
    });
  });
  app.get("/p/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const current = await service.read(id, ip(c));
      return c.html(linkMetadata(index, id, current.readId, options.origin, current.content));
    } catch (error) {
      // The SPA renders its actionable gone/blocked/offline states. Do not expose stale metadata.
      if (error instanceof NotesError) return c.html(index, error.status);
      console.error("[notes] page_failed");
      return c.html(index, 500);
    }
  });
  app.get("*", (c) => {
    if (!options.adminPasswordHash && (c.req.path === "/admin" || c.req.path.startsWith("/admin/"))) throw new NotesError("not_found", 404);
    const asset = assets.get(c.req.path);
    if (asset) {
      const cache =
        c.req.path === "/sw.js"
          ? "no-cache"
          : /^\/assets\/[^/]+-[a-z0-9]{8,}\.(?:js|css|woff2?|png|svg|webp|avif)$/i.test(c.req.path)
            ? "public, max-age=31536000, immutable"
            : "private, no-store";
      return new Response(asset, { headers: { "Content-Type": asset.type, "Cache-Control": cache } });
    }
    if (c.req.path.startsWith("/api/") || /\.[a-z0-9]+$/i.test(c.req.path)) throw new NotesError("not_found", 404);
    return c.html(index);
  });
};
