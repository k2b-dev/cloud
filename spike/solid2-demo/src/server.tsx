import { Hono } from "hono";
import { config, routes } from "./config";
import Hello from "./pages/Hello";
import Board from "./pages/Board";
import Mail from "./pages/Mail";

const root = `${import.meta.dir}/..`;
const file = (path: string, type: string) => () =>
  new Response(Bun.file(path), { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });

const app = new Hono()
  .route("/_ssr", routes(config))
  .get("/v2.css", file(`${root}/../../packages/ui/src/v2/v2.css`, "text/css"))
  .get("/demo.css", file(`${root}/public/demo.css`, "text/css"))
  .get("/fonts/:name{plex-sans-[456]00\\.woff2}", (c) => file(`${root}/public/fonts/${c.req.param("name")}`, "font/woff2")())
  .get("/", (c) => c.redirect("/mail"))
  .get("/hello", ...Hello)
  .get("/mail", ...Mail)
  .get("/dnd", ...Board);

export default { port: Number(process.env.PORT ?? 4391), fetch: app.fetch };
