import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";
import { BRAND } from "../src/brand";
import { iconStyles } from "./icons";
import { writeServiceWorker } from "./service-worker";

export const packageRoot = resolve(import.meta.dir, "..");
export const dist = resolve(packageRoot, "dist");

const solid: BunPlugin = {
  name: "notes-site-solid",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        babelrc: false,
        configFile: false,
        presets: [
          [Bun.resolveSync("@babel/preset-typescript", packageRoot), {}],
          [Bun.resolveSync("babel-preset-solid", packageRoot), { generate: "dom", hydratable: false }],
        ],
      });
      if (!result?.code) throw new Error(`Solid transform failed: ${path}`);
      return { contents: result.code, loader: "js" };
    });
  },
};

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export async function build({ development = false, outdir = dist } = {}) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(packageRoot, "src/main.tsx"), resolve(packageRoot, "src/styles.css")],
    outdir: resolve(outdir, "assets"),
    target: "browser",
    splitting: true,
    conditions: ["browser"],
    plugins: [solid, tailwind],
    minify: !development,
    sourcemap: development ? "linked" : "none",
    naming: "[name]-[hash].[ext]",
    define: {
      "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"),
      __NOTES_OFFLINE__: JSON.stringify(!development),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Notes site build failed");
  const entry = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  // One stylesheet: the site styles set the tokens first, CSS that components import (such as the admin page) follows.
  const isSiteStyles = (path: string) => basename(path).startsWith("styles-");
  const css = result.outputs
    .filter((output) => output.path.endsWith(".css"))
    .sort((a, b) => Number(isSiteStyles(b.path)) - Number(isSiteStyles(a.path)) || a.path.localeCompare(b.path));
  if (!entry || !css.some((output) => isSiteStyles(output.path))) throw new Error("Missing notes site build output");
  const scripts = await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map((output) => output.text()));
  const styles = await Promise.all(css.map((output) => output.text()));
  const cssText = `${styles.join("\n")}\n${await iconStyles(scripts.join("\n"))}`;
  const cssName = `styles-${Bun.hash(cssText).toString(16)}.css`;
  await Promise.all(css.map((output) => rm(output.path)));
  await Bun.write(resolve(outdir, "assets", cssName), cssText);
  // index.html links one stylesheet; any other CSS file would be styles the page never loads.
  const stylesheets = (await readdir(resolve(outdir, "assets"))).filter((name) => name.endsWith(".css"));
  if (stylesheets.length !== 1) throw new Error(`Expected one stylesheet, found ${stylesheets.join(", ")}`);
  await cp(resolve(packageRoot, "public"), outdir, { recursive: true });
  await Bun.write(
    resolve(outdir, "manifest.webmanifest"),
    JSON.stringify({
      name: BRAND,
      short_name: BRAND,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
    }),
  );
  // The server fills <!--og--> for shared links (/p/…); everything else gets the file unchanged.
  await Bun.write(
    resolve(outdir, "index.html"),
    `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#11151b" media="(prefers-color-scheme: dark)">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(BRAND)}</title>
  <!--og-->
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/assets/${cssName}">
  <script type="module" src="/assets/${entry.path.split("/").pop()}"></script>
</head>
<body class="k2b-ui">
  <div id="root"></div>
  <noscript><p>Diese Seite braucht JavaScript. This site needs JavaScript.</p></noscript>
</body>
</html>
`,
  );
  if (!development) await writeServiceWorker(outdir);
  console.log(`Built notes site → ${outdir}`);
}

if (import.meta.main) await build({ development: process.argv.includes("--development") });
