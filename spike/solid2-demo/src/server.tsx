import { Hono } from "hono";
import { config, routes } from "./config";
import Hello from "./pages/Hello";
import Board from "./pages/Board";
import Mail from "./pages/Mail";

const root = `${import.meta.dir}/..`;
const file = (path: string, type: string, cache = "no-cache") => () =>
  new Response(Bun.file(path), { headers: { "Content-Type": type, "Cache-Control": cache } });
// The faces never change; a reload takes them from the cache, so the first frame already has them. With no-cache and
// no validator, every reload fetched them again and the text was invisible until they arrived.
const fontCache = "public, max-age=31536000, immutable";

const app = new Hono()
  .route("/_ssr", routes(config))
  .get("/v2.css", file(`${root}/../../packages/ui/src/v2/v2.css`, "text/css"))
  .get("/demo.css", file(`${root}/public/demo.css`, "text/css"))
  .get("/fonts/:name{plex-sans-[456]00\\.woff2}", (c) => file(`${root}/public/fonts/${c.req.param("name")}`, "font/woff2", fontCache)())
  .get("/", (c) => c.redirect("/mail"))
  .get("/hello", ...Hello)
  .get("/mail", ...Mail)
  .get("/dnd", ...Board);

export default { port: Number(process.env.PORT ?? 4391), fetch: app.fetch };
