import { Hono } from "hono";
import { z } from "zod";
import { NotesError } from "./errors";
import { fileDisposition, fileKey, readUpload } from "./files";
import { boundedJson, requireOrigin, snapshotBytes } from "./http";
import { limits, requestIp } from "./limits";
import type { NotesService } from "./service";

export type NotesBindings = { peerIp?: string };
export type HttpOptions = { origin: string; trustedProxy?: string };
const createPad = z.strictObject({
  snapshot: z.string().max(Math.ceil(limits.stateBytes / 3) * 4),
  accepted: z.literal(true),
  title: z.string().max(200).optional(),
});

export const createNotesApp = (ready: () => Promise<boolean>, service?: NotesService, options?: HttpOptions) => {
  const app = new Hono<{ Bindings: NotesBindings }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  app.onError((error, c) => {
    if (error instanceof NotesError) return c.json({ code: error.code, ...(error.reason ? { reason: error.reason } : {}) }, error.status);
    console.error("[notes] request_failed");
    return c.json({ code: "internal_error" }, 500);
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const available = await ready().catch(() => false);
    return c.json({ status: available ? "ready" : "unavailable" }, available ? 200 : 503);
  });
  if (service && options) {
    const ip = (c: { env: NotesBindings; req: { header: (name: string) => string | undefined } }) =>
      requestIp(c.env?.peerIp, c.req.header("x-forwarded-for") ?? null, options.trustedProxy);
    app.use("/api/*", async (c, next) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) requireOrigin(c.req.raw, options.origin);
      await next();
    });
    app.get("/api/status", async (c) => {
      const status = await service.store.status();
      return c.json({
        sharingPaused: status.sharingPaused,
        storageFull: status.full,
        limits: {
          text: limits.text,
          stateBytes: limits.stateBytes,
          fileBytes: limits.fileBytes,
          files: limits.files,
          peers: limits.peersPerPad,
        },
      });
    });
    app.post("/api/pads", async (c) => {
      service.rates.take("create_request", ip(c), limits.createPerHour, 3_600_000);
      const input = createPad.safeParse(await boundedJson(c.req.raw, Math.ceil(limits.stateBytes / 3) * 4 + 1024));
      if (!input.success) throw new NotesError("invalid_pad");
      return c.json(await service.create(snapshotBytes(input.data.snapshot), ip(c)), 201);
    });
    app.get("/api/pads/:id", async (c) => c.json(await service.read(c.req.param("id"), ip(c))));
    let transferring = 0;
    const transfer = async <T>(run: () => Promise<T>): Promise<T> => {
      if (transferring >= service.options.maxOpenPads) throw new NotesError("transfers_full", 503);
      transferring++;
      try {
        return await run();
      } finally {
        transferring--;
      }
    };
    app.post("/api/pads/:id/files", async (c) =>
      transfer(async () => {
        service.rates.take("upload", ip(c), limits.uploadPerHour, 3_600_000);
        await service.store.editablePad(c.req.param("id"));
        return c.json(await service.upload(c.req.param("id"), await readUpload(c.req.raw)), 201);
      }),
    );
    app.get("/api/pads/:id/files/:key", async (c) =>
      transfer(async () => {
        service.rates.take("download", ip(c), limits.files * limits.peersPerPad, 3_600_000);
        const key = fileKey.safeParse(c.req.param("key"));
        if (!key.success) throw new NotesError("not_found", 404);
        const file = await service.store.getFile(c.req.param("id"), key.data);
        return new Response(file.bytes, {
          headers: { "Content-Type": file.type, "Content-Disposition": fileDisposition(file) },
        });
      }),
    );
    app.post("/api/pads/:id/opened", async (c) => {
      await service.humanOpen(c.req.param("id"), ip(c));
      return c.body(null, 204);
    });
    app.delete("/api/pads/:id", async (c) => {
      await service.remove(c.req.param("id"));
      return c.body(null, 204);
    });
  }
  app.notFound((c) => c.json({ code: "not_found" }, 404));
  return app;
};
