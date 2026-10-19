import { createMiddleware } from "hono/factory";

export const noTransform = () =>
  createMiddleware(async (c, next) => {
    await next();
    if (c.res.status === 101) return;
    const value = c.res.headers.get("Cache-Control");
    if (
      (value?.match(/(?:[^,"]|"[^"]*")+/g) ?? []).some((directive) => directive.split("=", 1)[0]?.trim().toLowerCase() === "no-transform")
    )
      return;
    const merged = value ? `${value}, no-transform` : "no-transform";
    try {
      c.res.headers.set("Cache-Control", merged);
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("Cache-Control", merged);
    }
  });
