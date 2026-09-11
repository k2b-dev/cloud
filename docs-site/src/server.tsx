import { createFibelApp } from "@k2b/fibel";
import { Hono } from "hono";
import { dirname, extname, join, normalize, resolve } from "path";
import fibelConfig from "../fibel.config";
import { linkedChartSnapshot, parseGroupRequest } from "./ui/chart-group-data";
import HomePage from "./home/HomePage";
import { html, config as ssrConfig } from "./ssr";
import { siteTheme } from "./site-config";

const fibelApp = await createFibelApp(fibelConfig);
const app = new Hono();
const assetsRoot = process.env.NODE_ENV === "production" ? join(import.meta.dir, "assets") : resolve(import.meta.dir, "..", "assets");
const ssrRoot = ssrConfig.dev ? (ssrConfig.rootDir ?? process.cwd()) : dirname(Bun.main);

const themeFromRequest = (request: Request) => {
  const theme = request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${siteTheme.cookieName}=(dark|light)(?:;|$)`))?.[1];
  return theme === "dark" ? "dark" : "light";
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const serveAsset = async (relativePath: string) => {
  const path = normalize(join(assetsRoot, relativePath));
  if (!path.startsWith(`${assetsRoot}/`)) return new Response("Not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Type": contentTypes[extname(path)] ?? file.type,
      "Cache-Control": "no-cache",
    },
  });
};

app.use("*", async (c, next) => {
  await next();

  const path = c.req.path;
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (!c.res.headers.has("Cache-Control")) {
    const contentType = c.res.headers.get("Content-Type") ?? "";

    if (path === "/health") {
      c.header("Cache-Control", "no-store");
    } else if (contentType.startsWith("text/html")) {
      c.header("Cache-Control", "private, no-cache");
      c.header("Vary", "Cookie", { append: true });
    } else {
      c.header("Cache-Control", "no-cache");
    }
  }
});

if (ssrConfig.dev) {
  app.get("/_ssr/_ping", (c) => c.text("ok"));
  app.get(
    "/_ssr/_reload",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            const interval = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(": ping\n\n"));
              } catch {
                clearInterval(interval);
              }
            }, 5000);
          },
        }),
        { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
      ),
  );
}
app.get("/_ssr/:filename{[a-zA-Z0-9._-]+\\.js(?:\\.map)?}", async (c) => {
  const filename = c.req.param("filename");
  const file = Bun.file(join(ssrRoot, "_ssr", filename));
  if (!(await file.exists())) return c.notFound();
  return new Response(file, {
    headers: {
      "Content-Type": filename.endsWith(".map") ? "application/json; charset=utf-8" : "application/javascript; charset=utf-8",
      "Cache-Control": ssrConfig.dev ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
});
app.get("/", (c) => c.redirect("/en", 302));
app.get("/en", (c) =>
  html(() => <HomePage theme={themeFromRequest(c.req.raw)} themeCookieName={siteTheme.cookieName} />, {
    title: "Cloud — the open-source application platform",
    description: "Shared application building blocks, operated on your infrastructure.",
    path: "/en",
    theme: themeFromRequest(c.req.raw),
  }),
);
app.get("/assets/:path{.+}", (c) => serveAsset(c.req.param("path")));
app.get("/api/ui/chart-exploration", (c) => {
  const request = parseGroupRequest(new URL(c.req.url));
  if (!request) return c.json({ error: "Invalid chart filters" }, 400);
  return c.json(linkedChartSnapshot(request));
});
app.get("/health", (c) => c.json({ status: "ok", surfaces: ["/en", "/en/docs", "/en/ui"] }));
app.get("/humans.txt", (c) =>
  c.text(`Cloud
Open-source application platform
Runtime: Bun
Docs: Fibel
UI: SolidJS

Try: g then d, or g then u
`),
);
app.mount("/", fibelApp.fetch, { replaceRequest: false });
app.notFound((c) => c.text("Not found", 404));

export default {
  port: Number(process.env.PORT ?? 4187),
  fetch: app.fetch,
};
