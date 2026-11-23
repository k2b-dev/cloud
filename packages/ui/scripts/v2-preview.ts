#!/usr/bin/env bun
/**
 * Shows an agent what a v2 screen looks like before a person does, cheapest first: type errors, the layout-CSS rule,
 * a text outline from `describeV2`, the layout rules measured in Chromium at 1440 and 390 px, and on request a
 * screenshot. Used by the `k2b-ui` skill (packages/ui/skills/k2b-ui) and to draw its recipe pictures.
 *
 * The screen is a `.tsx` file whose default export is a component without props. `@k2b/ui/v2` resolves to the source
 * of this checkout, so no build is needed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";

const HELP = `Usage: bun packages/ui/scripts/v2-preview.ts <screen.tsx> [options]

Checks one v2 screen and prints what it shows. The file's default export is a component without props.

Steps, cheapest first; each prints its findings and the run goes on:
  1. types     TypeScript errors in the screen (wrong props, a missing label)
  2. rule      the v2-app-layout-css rule (class, style, CSS outside Canvas)
  3. outline   describeV2 at each width: parts, texts, counts, problems
  4. layout    measureV2Layout at each width: edges, double lines, type roles, grips

Options:
  --text           steps 1-3 only, without a browser (outline from the server markup, no widths)
  --png <dir>      also save a light screenshot per width as <dir>/<name>-<width>.png
  --width <list>   widths in px, comma separated (default 1440,390)
  --height <px>    viewport height (default 900)
  --help           this text

Exit code: 0 when every step is clean, 1 when a step found a problem, 2 on a usage error.
On the shared VM run it through the heavy wrapper; without --text it starts a browser.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = resolve(
  args.find((arg, index) => !arg.startsWith("--") && !["--png", "--width", "--height"].includes(args[index - 1] ?? ""))!,
);
if (!existsSync(file) || !/\.tsx?$/.test(file)) {
  console.error(`v2-preview: ${file} is no .tsx file`);
  process.exit(2);
}
const textOnly = args.includes("--text");
const pngDir = option("--png");
const widths = (option("--width") ?? "1440,390").split(",").map(Number);
const height = Number(option("--height") ?? 900);
if (widths.some((width) => !Number.isFinite(width) || width < 200) || !Number.isFinite(height)) {
  console.error("v2-preview: --width takes px values such as 1440,390");
  process.exit(2);
}

const uiRoot = resolve(import.meta.dir, "..");
const v2Entry = join(uiRoot, "src/v2/index.ts");
const shown = relative(process.cwd(), file);
let failed = false;
const section = (title: string, body: string[]) => {
  console.log(`\n## ${title}${body.length ? "" : ": clean"}`);
  for (const line of body) console.log(line);
};

// 1. Types, with the compiler options of packages/ui and @k2b/ui/v2 mapped to the source.
{
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(uiRoot, "tsconfig.json"),
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  const program = ts.createProgram({
    rootNames: [file],
    options: { ...parsed?.options, paths: { "@k2b/ui/v2": [v2Entry] } },
  });
  const own = program
    .getSourceFiles()
    .filter((source) => !source.fileName.includes("/node_modules/") && !source.fileName.startsWith(join(uiRoot, "src")));
  const found = own
    .flatMap((source) => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)])
    .map((diagnostic) => {
      const where =
        diagnostic.file && diagnostic.start !== undefined
          ? `${relative(process.cwd(), diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
          : shown;
      return `- ${where} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
  if (found.length) failed = true;
  section("types", found.slice(0, 12).concat(found.length > 12 ? [`- … ${found.length - 12} more`] : []));
}

// 2. The repository rule v2-app-layout-css, as `bun run check` runs it on an app.
{
  const { layoutInV2Source } = await import("../../../scripts/checks/v2-app-layout-css");
  const hits = layoutInV2Source(file, readFileSync(file, "utf8"));
  if (hits.length) failed = true;
  section(
    "rule v2-app-layout-css",
    hits.map((hit) => `- ${shown}:${hit.line} ${hit.message}`),
  );
}

// 3. Render on the server, with the same compiler as the package's browser tests.
const root = mkdtempSync(join(tmpdir(), "k2-v2-preview-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
Bun.plugin({
  name: "k2b-ui-v2-source",
  setup(build) {
    build.onResolve({ filter: /^@k2b\/ui\/v2$/ }, () => ({ path: v2Entry }));
  },
});
const { registerSsrTestPlugin } = await import("../test/ssr-test-plugin");
registerSsrTestPlugin({ dev: true, rootDir: root });
const { createComponent } = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { describeV2 } = await import("../src/v2/describe");

let markup = "";
try {
  const screen = (await import(file)) as { default?: () => unknown };
  if (typeof screen.default !== "function") throw new Error("the file has no default export that is a component");
  const component = screen.default as Parameters<typeof createComponent>[0];
  markup = renderToString(() => createComponent(component, {}));
} catch (error) {
  failed = true;
  section("render", [`- ${error instanceof Error ? error.message : String(error)}`]);
  process.exit(1);
}

const css = readFileSync(join(uiRoot, "src/v2/v2.css"), "utf8");
const fontFace = (weight: number) => {
  const path = join(uiRoot, `node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`);
  return existsSync(path)
    ? `@font-face{font-family:"IBM Plex Sans";font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2")}`
    : "";
};
const tablerCss = () => {
  const dist = join(uiRoot, "node_modules/@tabler/icons-webfont/dist");
  if (!existsSync(join(dist, "tabler-icons.min.css"))) return ".ti{display:inline-block;width:1em;height:1em}";
  const font = readFileSync(join(dist, "fonts/tabler-icons.woff2")).toString("base64");
  return readFileSync(join(dist, "tabler-icons.min.css"), "utf8").replace(
    /@font-face\{[^}]*\}/,
    `@font-face{font-family:"tabler-icons";font-display:block;src:url(data:font/woff2;base64,${font}) format("woff2")}`,
  );
};
const page = (fonts: boolean) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${fonts ? [400, 500, 600].map(fontFace).join("") + tablerCss() : ".ti{display:inline-block;width:1em;height:1em}"}</style>` +
  `<style>${css}</style><style>html,body{margin:0;height:100%;background:#fff}body{color-scheme:light}.frame{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2-ui" data-theme="light"><div class="frame">${markup}</div></body></html>`;

if (textOnly) {
  const { Window } = await import("happy-dom");
  const window = new Window();
  window.document.body.innerHTML = `<div class="k2-ui">${markup}</div>`;
  const outline = describeV2(window.document.body.firstElementChild as unknown as Element);
  if (outline.includes("\nProblems (")) failed = true;
  section("outline (server markup)", outline.split("\n"));
  await window.happyDOM.close();
  process.exit(failed ? 1 : 0);
}

// 4. Measure in Chromium at each width.
const { launchBrowser, settled } = await import("../test/browser");
const { measureV2Layout } = await import("../test/measure-v2-layout");
const browser = await launchBrowser();
try {
  for (const width of widths) {
    const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: "light" });
    try {
      await tab.setContent(page(true));
      await settled(tab);
      const outline = (await tab.evaluate(`(${describeV2.toString()})(document.querySelector(".frame"), { layout: true })`)) as string;
      if (outline.includes("\nProblems (")) failed = true;
      section(`outline at ${width} px`, outline.split("\n"));
      const layout = await measureV2Layout(tab, { root: "[data-k2-workspace], .frame" });
      if (layout.problems.length) failed = true;
      section(
        `layout at ${width} px (${layout.measured.lines} lines, ${layout.measured.texts} texts measured)`,
        layout.problems
          .slice(0, 15)
          .map((problem) => `- ${problem}`)
          .concat(layout.problems.length > 15 ? [`- … ${layout.problems.length - 15} more`] : []),
      );
      if (pngDir) {
        mkdirSync(resolve(pngDir), { recursive: true });
        const target = join(resolve(pngDir), `${basename(file).replace(/\.tsx?$/, "")}-${width}.png`);
        writeFileSync(target, await tab.screenshot({ fullPage: false }));
        console.log(`\nscreenshot: ${relative(process.cwd(), target)}`);
      }
    } finally {
      await tab.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failed ? "\nResult: problems found." : "\nResult: clean.");
process.exit(failed ? 1 : 0);
