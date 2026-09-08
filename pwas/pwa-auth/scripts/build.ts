import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";
import { authMessages } from "../src/i18n";

export const packageRoot = resolve(import.meta.dir, "..");
export const dist = resolve(packageRoot, "dist");

const solid: BunPlugin = {
  name: "pwa-auth-solid",
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

export async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(packageRoot, "src/main.tsx"), resolve(packageRoot, "src/styles.css")],
    outdir: resolve(dist, "assets"),
    target: "browser",
    conditions: ["browser"],
    plugins: [solid],
    minify: true,
    naming: "[name]-[hash].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new AggregateError(result.logs, "PWA build failed");
  const entry = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  const css = result.outputs.find((output) => output.path.endsWith(".css"));
  if (!entry || !css) throw new Error("Missing PWA build output");
  await cp(resolve(packageRoot, "public"), dist, { recursive: true });
  const en = authMessages.resolve(["en"]).t;
  const de = authMessages.resolve(["de"]).t;
  await Bun.write(
    resolve(dist, "index.html"),
    `<!doctype html>
<html lang="en" class="k2b-ui">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">
  <meta name="referrer" content="no-referrer">
  <title>${en.appName}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/assets/${css.path.split("/").pop()}">
</head>
<body>
  <div id="root"></div>
  <noscript><p lang="en">${en.javascriptRequired}</p><p lang="de">${de.javascriptRequired}</p></noscript>
  <script type="module" src="/assets/${entry.path.split("/").pop()}"></script>
</body>
</html>
`,
  );
  console.log(`Built pwa-auth → ${dist}`);
}

if (import.meta.main) await build();
