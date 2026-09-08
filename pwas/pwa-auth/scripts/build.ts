import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";
import { authMessages } from "../src/i18n";
import { iconStyles } from "./icons";
import { writeServiceWorker } from "./service-worker";

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

export async function build({ development = false } = {}) {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(packageRoot, "src/main.tsx"), resolve(packageRoot, "src/styles.css")],
    outdir: resolve(dist, "assets"),
    target: "browser",
    splitting: true,
    conditions: ["browser"],
    plugins: [solid],
    minify: true,
    naming: "[name]-[hash].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), __PWA_OFFLINE__: JSON.stringify(!development) },
  });
  if (!result.success) throw new AggregateError(result.logs, "PWA build failed");
  const entry = result.outputs.find((output) => output.kind === "entry-point" && output.path.endsWith(".js"));
  const css = result.outputs.find((output) => output.path.endsWith(".css"));
  if (!entry || !css) throw new Error("Missing PWA build output");
  const scripts = await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map((output) => output.text()));
  const cssText = (await css.text()) + "\n" + (await iconStyles(scripts.join("\n")));
  const cssName = `styles-${Bun.hash(cssText).toString(16)}.css`;
  await rm(css.path);
  await Bun.write(resolve(dist, "assets", cssName), cssText);
  await cp(resolve(packageRoot, "public"), dist, { recursive: true });
  await mkdir(resolve(dist, "licenses"), { recursive: true });
  await cp(resolve(dirname(Bun.resolveSync("qr-scanner", packageRoot)), "LICENSE"), resolve(dist, "licenses/qr-scanner.txt"));
  await cp(
    resolve(dirname(Bun.resolveSync("hash-wasm/package.json", resolve(packageRoot, "../../packages/cloud"))), "LICENSE"),
    resolve(dist, "licenses/hash-wasm.txt"),
  );
  const en = authMessages.resolve(["en"]).t;
  const de = authMessages.resolve(["de"]).t;
  await Bun.write(
    resolve(dist, "index.html"),
    `<!doctype html>
<html lang="en">
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
  <link rel="stylesheet" href="/assets/${cssName}">
</head>
<body class="k2b-ui">
  <script>
(() => {
  let theme;
  try { theme = JSON.parse(localStorage.getItem("pwa-auth.preferences") || "null")?.theme; } catch {}
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.dataset.theme = dark ? "dark" : "light";
  const color = dark ? "#090d12" : "#fafafa";
  document.documentElement.style.backgroundColor = color;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) { meta.removeAttribute("media"); meta.content = color; }
})();
</script>
  <div id="root"></div>
  <noscript><p lang="en">${en.javascriptRequired}</p><p lang="de">${de.javascriptRequired}</p></noscript>
  <script type="module" src="/assets/${entry.path.split("/").pop()}"></script>
</body>
</html>
`,
  );
  if (!development) await writeServiceWorker(dist);
  console.log(`Built pwa-auth → ${dist}`);
}

if (import.meta.main) await build();
