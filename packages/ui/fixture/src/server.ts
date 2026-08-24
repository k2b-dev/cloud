import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { config, routes } from "./config";
import intlPage from "./intl-page";
import page from "./page";

const stylesPath = fileURLToPath(import.meta.resolve("@k2b/ui/styles.css"));
const assetRoot = dirname(stylesPath);
const styles = [
  readFileSync(stylesPath, "utf8"),
  readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css")), "utf8"),
].join("\n");
const fontAssets = new Map(
  readdirSync(assetRoot)
    .filter((file) => [".woff2", ".woff", ".ttf"].includes(extname(file)))
    .map((file) => [file, readFileSync(`${assetRoot}/${file}`)]),
);
const islandAssetPattern = /^[a-z0-9._-]+\.js$/i;

export const app = new Hono()
  .get("/_ssr/:filename", async (context) => {
    const filename = context.req.param("filename");
    if (!islandAssetPattern.test(filename)) return context.notFound();
    const file = Bun.file(`${dirname(Bun.main)}/_ssr/${filename}`, { type: "application/javascript" });
    if (!(await file.exists())) return context.notFound();
    return new Response(file, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  .route("/_ssr", routes(config))
  .get("/styles.css", (context) => context.body(styles, 200, { "Content-Type": "text/css; charset=utf-8" }))
  .get("/intl", ...intlPage)
  .get("/:asset", (context) => {
    const asset = fontAssets.get(context.req.param("asset"));
    if (!asset) return context.notFound();
    return context.body(asset, 200, {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  })
  .get("/", ...page);

export default {
  port: Number(process.env.PORT ?? 4317),
  fetch: app.fetch,
};
