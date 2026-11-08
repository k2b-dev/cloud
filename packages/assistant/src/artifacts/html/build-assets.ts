// Builds the frame prelude, chart parts and @k2b/ui base stylesheet with Plex
// faces as data URLs. The host holds the parts; app frames load nothing from
// the network and receive only requested kinds over the existing bridge.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import type { RareChart } from "../runtime/chart-renderer-types";
import { CHART_SHARED_IMPORT, type ChartPart, type ChartParts } from "./chart-parts";

// App frames strip the embedded SVG stylesheet and use their shared base.css.
// Omit that duplicate from the offline asset; standalone charts keep it verbatim.
const frameChartStyles: BunPlugin = {
  name: "frame-chart-styles",
  setup(build) {
    build.onLoad({ filter: /\/charts\/core\/default-styles\.[jt]s$/ }, () => ({
      contents: 'export const DEFAULT_STYLES = "";',
      loader: "js",
    }));
  },
};

export function buildPrelude(): Promise<string> {
  return buildFrame("frame.ts");
}

export function buildCheckPrelude(): Promise<string> {
  return buildFrame("check-frame.ts");
}

async function buildFrame(entry: string): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "import.meta.url": JSON.stringify("about:blank") },
    plugins: [
      frameChartStyles,
      {
        name: "offline-chart-module",
        setup(build) {
          build.onResolve({ filter: /^\.\/chart-renderers-rare$/ }, () => ({
            path: join(import.meta.dir, "../runtime/chart-renderers-frame.ts"),
          }));
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "The app frame prelude did not build");
  // The prelude is the text of an inline <script>; a literal "</script" would end it early.
  return (await build.outputs[0]!.text()).trim().replace(/<\/(script)/gi, "<\\/$1");
}

/** Split at renderer exports; Bun deduplicates helpers into one shared asset. */
export async function buildChartParts(): Promise<ChartParts> {
  // The exhaustive dispatch switch alone cannot catch a forgotten named export.
  const renderers = (await import("../runtime/chart-renderers-rare")) satisfies Record<RareChart["kind"], unknown>;
  const kinds = Object.keys(renderers).filter((name) => !["rareChartSvg", "loadChartRenderer", "deferChartDrawing"].includes(name));
  const build = await Bun.build({
    entrypoints: kinds.map((kind) => `chart-kind:${kind}.ts`),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    naming: { entry: "[name].js", chunk: "shared-[hash].js" },
    plugins: [
      frameChartStyles,
      {
        name: "chart-kind-entries",
        setup(build) {
          build.onResolve({ filter: /^chart-kind:/ }, ({ path }) => ({ path: path.slice(11), namespace: "chart-kind" }));
          build.onLoad({ filter: /.*/, namespace: "chart-kind" }, ({ path }) => ({
            contents: `export { ${path.slice(0, -3)} as render } from ${JSON.stringify(join(import.meta.dir, `../runtime/chart-kind-${path}`))};`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "The chart parts did not build");
  const shared = build.outputs.filter((output) => /\/shared-/.test(output.path) && output.size);
  if (shared.length !== 1) throw new Error(`Expected one shared chart part, got ${shared.length}`);
  const sharedName = shared[0]!.path.split("/").pop()!;
  const part = (source: string): ChartPart => {
    const code = source.trim();
    return { code, hash: new Bun.CryptoHasher("sha256").update(code).digest("hex") };
  };
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      const output = build.outputs.find((output) => output.path.endsWith(`/chart-kind:${kind}.js`));
      if (!output) throw new Error(`Missing chart part: ${kind}`);
      const code = (await output.text()).replaceAll(`"./${sharedName}"`, JSON.stringify(CHART_SHARED_IMPORT));
      return [kind, part(code)] as const;
    }),
  );
  return { shared: part(await shared[0]!.text()), kinds: Object.fromEntries(entries) };
}

/** Plex Sans 400-700 and Plex Mono 400, Latin and Latin Extended (Łukasz, Şahin), as in the base stylesheet's tokens. */
const keep = (family: string, weight: number, file: string) =>
  /-(latin|latin-ext)-\d+-normal-/.test(file) &&
  ((family === "IBM Plex Sans" && weight >= 400 && weight <= 700) || (family === "IBM Plex Mono" && weight === 400));

export async function buildBaseCss(): Promise<string> {
  const ui = join(dirname(Bun.resolveSync("@k2b/ui/package.json", import.meta.dir)), "dist");
  const [base, plex] = await Promise.all([readFile(join(ui, "base.css"), "utf8"), readFile(join(ui, "plex.css"), "utf8")]);
  const faces: string[] = [];
  for (const [face] of plex.matchAll(/@font-face\{[^}]*\}/g)) {
    const family = /font-family:([^;]+);/.exec(face)?.[1]?.replaceAll('"', "").trim() ?? "";
    const weight = Number(/font-weight:(\d+)/.exec(face)?.[1]);
    const file = /url\(\.\/fonts\/([^)]+\.woff2)\)/.exec(face)?.[1];
    if (!file || !/font-style:normal/.test(face) || !keep(family, weight, file)) continue;
    const data = (await readFile(join(ui, "fonts", file))).toString("base64");
    faces.push(face.replace(/url\([^)]+\)/, `url(data:font/woff2;base64,${data})`));
  }
  if (faces.length !== 10) throw new Error(`Expected 10 Plex faces for app frames, found ${faces.length}`);
  return faces.join("") + base.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n/g, "\n");
}
