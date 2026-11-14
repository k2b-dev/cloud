import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const WEBFONT = "@tabler/icons-webfont/dist/tabler-icons.min.css";

/**
 * Keeps the WOFF2 source of every `tabler-icons` font face and drops the others. Tabler 3.48 lists WOFF2, WOFF, and
 * TrueType in one face; from 3.50 the font is split into unicode-range faces with one WOFF2 source each. Faces of
 * other families pass through unchanged. Fails when the stylesheet has no Tabler face, or a face has no WOFF2 file.
 *
 * An element takes its line metrics from the first face whose range covers the space. No split face does, so an
 * icon would sit on the fallback font's baseline, about a tenth of an em off its box; the first face therefore also
 * covers the space, and icons keep the position they have with the single font.
 */
export function woff2Sources(css: string): { css: string; fonts: string[] } {
  const fonts: string[] = [];
  const reduced = css.replace(/@font-face\s*\{[^}]*\}/g, (face) => {
    if (!/font-family:\s*(["']?)tabler-icons\1\s*[;}]/.test(face)) return face;
    const src = /src:([^;}]*)/.exec(face);
    const sources = [...(src?.[1] ?? "").matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)\s*format\(\s*(["']?)([\w-]+)\3\s*\)/g)];
    const woff2 = sources.find((source) => source[4] === "woff2")?.[2];
    if (!src || !woff2 || woff2.startsWith("data:")) {
      throw new Error(`@k2b/ui found a Tabler font face without a WOFF2 file: ${face.slice(0, 200)}`);
    }
    const reducedFace = face.replace(src[0], `src:url(${woff2})format("woff2")`);
    fonts.push(woff2);
    return fonts.length === 1 ? reducedFace.replace(/unicode-range:\s*/, "unicode-range:U+20,") : reducedFace;
  });
  if (fonts.length === 0) throw new Error("@k2b/ui found no Tabler font face to reduce to WOFF2");
  return { css: reduced, fonts };
}

/**
 * Writes `tabler.css` and one content-named WOFF2 file per Tabler font face to `outdir`. Bun would inline small font
 * files as data URLs, which turns the split fonts of Tabler 3.50 into a megabyte of blocking CSS, so the fonts are
 * copied here and reach the bundler only as external files. `webfont` is the Tabler stylesheet that the preset's
 * `@import` names.
 */
export async function buildTablerPreset(outdir: string, webfont = Bun.resolveSync(WEBFONT, import.meta.dir)): Promise<void> {
  const source = await readFile(resolve(import.meta.dir, "../src/icons/tabler.css"), "utf8");
  const importRule = `@import "${WEBFONT}";`;
  if (!source.startsWith(importRule)) throw new Error(`@k2b/ui icon preset must start with ${importRule}`);
  const reduced = woff2Sources(await readFile(webfont, "utf8"));
  let css = reduced.css;
  for (const font of new Set(reduced.fonts)) {
    const path = font.replace(/[?#].*$/, "");
    const bytes = await readFile(resolve(dirname(webfont), path));
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = `${basename(path, ".woff2").replaceAll(".", "-")}-${hash}.woff2`;
    await writeFile(resolve(outdir, filename), bytes);
    css = css.replaceAll(`url(${font})`, `url(./${filename})`);
  }

  const work = await mkdtemp(join(tmpdir(), "k2b-ui-tabler-"));
  try {
    const entry = join(work, "tabler.css");
    await writeFile(entry, `${css}\n${source.slice(importRule.length)}`);
    const result = await Bun.build({ entrypoints: [entry], external: ["*.woff2"], minify: true });
    if (!result.success) throw new AggregateError(result.logs, "@k2b/ui tabler stylesheet build failed");
    const preset = await result.outputs[0]!.text();
    if (preset.includes("data:font/")) throw new Error("@k2b/ui icon preset must not inline a font");
    // The minified glyph names are UTF-8 characters. A page without a declared encoding would read them as Latin-1,
    // which no unicode-range face covers, so the split font would never load; the preset declares its encoding.
    await writeFile(resolve(outdir, "tabler.css"), `@charset "UTF-8";\n${preset}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
