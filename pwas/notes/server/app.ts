import { Hono } from "hono";

export const createNotesApp = (ready: () => Promise<boolean>) => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });
  // Do not log Request, URL, SQL errors, or exception messages: these can contain capability links.
  app.onError((_error, c) => {
    console.error("[notes] request_failed");
    return c.json({ error: "internal_error" }, 500);
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    const available = await ready().catch(() => false);
    return c.json({ status: available ? "ready" : "unavailable" }, available ? 200 : 503);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
};
