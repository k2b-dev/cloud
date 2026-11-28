/**
 * Core ships the assets routed through `/public/<plain-name>`:
 *   global.css   workspace-wide Tailwind stylesheet
 *   v2.css       v2 and Cloud's v2 additions alone, for v2 pages without the shell (MinimalLayout ui="v2")
 *   fonts.css    IBM Plex @font-face declarations
 *   fonts/*      IBM Plex WOFF2 files
 *   tabler-icons.css / .woff2  icon font stylesheet + font
 *   logo.svg     default branding fallback
 *
 * Invoked by packages/cloud/scripts/build.ts when APP_ID=core.
 */
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { buildFontAssets } from "./font-assets";
import { buildTablerIconAssets } from "./tabler-assets";

const root = process.env.WORKSPACE_ROOT!;
const dist = process.env.DIST_DIR!;
const publicDir = resolve(dist, "public");

// Build workspace-wide global.css from the root entry so the Tailwind oxide
// scanner walks every package and picks up all utility classes.
const css = await Bun.build({
  entrypoints: [resolve(root, "styles.css")],
  outdir: publicDir,
  naming: "global.css",
  minify: true,
  plugins: [tailwind],
});
if (!css.success) {
  for (const m of css.logs) console.error(m);
  throw new Error("Global CSS build failed");
}

// The v2-only sheet: no Tailwind and no v1, so a v2 visitor page loads a fraction of global.css.
const v2Css = await Bun.build({
  entrypoints: [resolve(root, "packages/cloud/src/styles/v2-page.css")],
  outdir: publicDir,
  naming: "v2.css",
  minify: true,
});
if (!v2Css.success) {
  for (const m of v2Css.logs) console.error(m);
  throw new Error("v2 CSS build failed");
}

await cp(resolve(root, "packages/cloud/public/logo.svg"), resolve(publicDir, "logo.svg"));
await buildFontAssets(publicDir);
await buildTablerIconAssets(publicDir);

// The authenticated map route reads glyphs from server assets in the bundled image.
await cp(new URL("./map-glyphs/", import.meta.resolve("@k2b/ui/package.json")), resolve(dist, "assets/map-glyphs"), { recursive: true });
