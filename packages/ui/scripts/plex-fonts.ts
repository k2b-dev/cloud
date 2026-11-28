import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Keep font binaries out of render-blocking CSS, including in the published preset. */
export async function buildPlexFonts(outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/fonts/plex.css")],
    external: ["*.woff", "*.woff2"],
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Plex stylesheet build failed");
  // `optional` instead of Fontsource's `swap`: a face that is not there for the first frame (Cloud preloads the Latin Sans
  // faces) never replaces the fallback on a page already shown, so no text and no button changes its width; the next page
  // finds the face in the cache (src/fonts/plex-late.browser.test.ts)
  let css = (await result.outputs[0]!.text())
    .replace(/,url\([^)]+\.woff\)format\(woff\)/g, "")
    .replaceAll("font-display:swap", "font-display:optional");
  const assets = new Set([...css.matchAll(/url\(\.\/files\/([^()]+\.woff2)\)/g)].map((match) => match[1]!));
  if (!assets.size || css.includes("data:") || /\.woff\)/.test(css)) throw new Error("Unexpected Plex font sources");
  if (css.match(/@font-face\{/g)?.length !== css.match(/font-display:optional/g)?.length)
    throw new Error("A Plex face without font-display: optional");
  await mkdir(resolve(outdir, "fonts"), { recursive: true });
  for (const asset of assets) {
    const family = asset.startsWith("ibm-plex-sans-") ? "ibm-plex-sans" : "ibm-plex-mono";
    const source = dirname(Bun.resolveSync(`@fontsource/${family}/400.css`, import.meta.dir));
    const bytes = await readFile(resolve(source, "files", asset));
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = asset.replace(".woff2", `-${hash}.woff2`);
    await writeFile(resolve(outdir, "fonts", filename), bytes);
    css = css.replaceAll(`./files/${asset}`, `./fonts/${filename}`);
  }
  await writeFile(resolve(outdir, "plex.css"), css);
}
