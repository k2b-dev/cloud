import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTablerPreset, woff2Sources } from "./tabler-fonts";

// Excerpts of `dist/tabler-icons.min.css` as Tabler ships it: 3.48 lists three formats in one face, 3.50 splits the
// font into unicode-range faces with one WOFF2 file each.
const v348 =
  '@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;src:url("./fonts/tabler-icons.woff2?v3.48.0") format("woff2"),url("./fonts/tabler-icons.woff?") format("woff"),url("./fonts/tabler-icons.ttf?v3.48.0") format("truetype")}.ti{font-family:"tabler-icons" !important}.ti-folder:before{content:"\\eaad"}';
const v350 =
  '@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;src:url("./fonts/tabler-icons.core.woff2?h3a24de11") format("woff2");unicode-range:U+EA03,U+EAAD}@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;src:url("./fonts/tabler-icons.numbers.woff2?h117cfd3d") format("woff2");unicode-range:U+EDF0-EDF9}.ti{font-family:"tabler-icons" !important}.ti-folder:before{content:"\\eaad"}';

test("keeps only the WOFF2 source of each Tabler face, in the 3.48 and the 3.50 format", () => {
  const old = woff2Sources(v348);
  expect(old.fonts).toEqual(["./fonts/tabler-icons.woff2?v3.48.0"]);
  expect(old.css).toContain('src:url(./fonts/tabler-icons.woff2?v3.48.0)format("woff2")}');
  expect(old.css).not.toMatch(/\.woff\?|\.ttf|unicode-range/);

  const split = woff2Sources(v350);
  expect(split.fonts).toEqual(["./fonts/tabler-icons.core.woff2?h3a24de11", "./fonts/tabler-icons.numbers.woff2?h117cfd3d"]);
  // The first face also covers the space, so icons take Tabler's line metrics as with the single font.
  expect(split.css).toContain('src:url(./fonts/tabler-icons.core.woff2?h3a24de11)format("woff2");unicode-range:U+20,U+EA03,U+EAAD}');
  expect(split.css).toContain('src:url(./fonts/tabler-icons.numbers.woff2?h117cfd3d)format("woff2");unicode-range:U+EDF0-EDF9}');
  expect(split.css).toContain(".ti-folder:before");
});

test("leaves other families alone and fails without a WOFF2 file", () => {
  const filled = '@font-face{font-family:"tabler-icons-filled";src:url("./fonts/filled.ttf") format("truetype")}';
  expect(woff2Sources(`${filled}${v350}`).css).toStartWith(filled);
  expect(() => woff2Sources(filled)).toThrow("no Tabler font face");
  expect(() => woff2Sources('@font-face{font-family:"tabler-icons";src:url("./fonts/t.ttf") format("truetype")}')).toThrow(
    "without a WOFF2 file",
  );
  expect(() => woff2Sources('@font-face{font-family:tabler-icons;src:url(data:font/woff2;base64,d09GMg==) format("woff2")}')).toThrow(
    "without a WOFF2 file",
  );
});

test("writes one content-named font file per face and never inlines a font", async () => {
  const root = await mkdtemp(join(tmpdir(), "k2b-ui-tabler-fonts-"));
  try {
    for (const [version, css, files] of [
      ["3.48", v348, ["tabler-icons.woff2", "tabler-icons.woff", "tabler-icons.ttf"]],
      ["3.50", v350, ["tabler-icons.core.woff2", "tabler-icons.numbers.woff2"]],
    ] as const) {
      const webfont = join(root, version, "dist");
      const outdir = join(root, version, "out");
      await mkdir(join(webfont, "fonts"), { recursive: true });
      await mkdir(outdir);
      await writeFile(join(webfont, "tabler-icons.min.css"), css);
      for (const file of files) await writeFile(join(webfont, "fonts", file), `font ${file}`);

      await buildTablerPreset(outdir, join(webfont, "tabler-icons.min.css"));

      const written = (await readdir(outdir)).sort();
      const fonts = written.filter((file) => file.endsWith(".woff2"));
      expect(fonts.map((file) => file.replace(/-[0-9a-f]{16}\.woff2$/, ""))).toEqual(
        version === "3.48" ? ["tabler-icons"] : ["tabler-icons-core", "tabler-icons-numbers"],
      );
      expect(written).toEqual([...fonts, "tabler.css"]);
      const preset = await readFile(join(outdir, "tabler.css"), "utf8");
      expect(preset).toStartWith('@charset "UTF-8";\n');
      expect([...preset.matchAll(/url\(([^)]+)\)format\(woff2\)/g)].map((match) => match[1])).toEqual(fonts.map((file) => `./${file}`));
      expect(preset).not.toMatch(/data:font|\.woff\b|\.ttf|\?v|\?h/);
      // The preset's own rules follow the Tabler stylesheet.
      expect(preset).toContain(".ti:before{display:inline-block;width:1em}");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
