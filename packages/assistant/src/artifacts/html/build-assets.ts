// Builds the two browser assets of an HTML app frame: the prelude (an IIFE that
// the app document pins by hash) and the base stylesheet of @k2b/ui with the
// Plex faces it needs as data URLs, because app frames load nothing from the network.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  });
  if (!build.success) throw new AggregateError(build.logs, "The app frame prelude did not build");
  // The prelude is the text of an inline <script>; a literal "</script" would end it early.
  return (await build.outputs[0]!.text()).trim().replace(/<\/(script)/gi, "<\\/$1");
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
