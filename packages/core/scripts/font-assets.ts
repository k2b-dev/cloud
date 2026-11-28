import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildFontAssets(publicDir: string): Promise<void> {
  const preset = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  const presetCss = await readFile(preset, "utf8");
  const css = [presetCss.replaceAll("./fonts/", "/public/fonts/")];
  const fontsDir = resolve(publicDir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  const presetAssets = new Set([...presetCss.matchAll(/url\(\.\/fonts\/([^()]+\.woff2)\)/g)].map((match) => match[1]!));
  if (!presetAssets.size || presetCss.includes("data:")) throw new Error("Plex preset must reference external WOFF2 assets");
  await Promise.all([...presetAssets].map((asset) => cp(resolve(dirname(preset), "fonts", asset), resolve(fontsDir, asset))));

  for (const weight of ["400", "500", "600", "700"]) {
    const sourcePath = fileURLToPath(import.meta.resolve(`@fontsource/ibm-plex-sans-condensed/${weight}.css`));
    const sourceCss = await readFile(sourcePath, "utf8");
    const assets = [...sourceCss.matchAll(/url\(\.\/files\/([^)"']+\.woff2)\)/g)].map((match) => match[1]!);
    if (assets.length === 0) throw new Error(`IBM Plex Sans Condensed ${weight} does not reference a WOFF2 asset`);
    await Promise.all(assets.map((asset) => cp(resolve(dirname(sourcePath), "files", asset), resolve(fontsDir, asset))));
    css.push(
      sourceCss
        .replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, "")
        .replace(/url\(\.\/files\/([^)"']+\.woff2)\)/g, (_match, asset: string) => `url("/public/fonts/${asset}")`),
    );
  }

  // Cloud preloads the Latin Sans faces (packages/cloud font-preloads), so they are there for the first frame. Every face
  // Cloud serves is `optional` instead of the presets' `swap`: one that misses the first frame never replaces the fallback
  // on a page already shown, so no text and no button changes its width; the next page finds it in the cache. The
  // `@k2b/ui` preset keeps `swap` for apps that do not preload (font-assets.browser.test.ts).
  const served = css.join("\n").replace(/font-display:\s*swap/g, "font-display:optional");
  if (/font-display:\s*(?!optional)/.test(served)) throw new Error("A face Cloud serves is not font-display: optional");
  await writeFile(resolve(publicDir, "fonts.css"), served);
}
