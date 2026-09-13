import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPlexFonts } from "./plex-fonts";

test("Plex preset ships every font source separately and preserves face selection", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "plex-fonts-"));
  try {
    await buildPlexFonts(directory);
    const css = await readFile(resolve(directory, "plex.css"), "utf8");
    expect(css).not.toContain("data:");
    expect(css).not.toContain("format(woff)");
    const faces = css.match(/@font-face\{[^}]+\}/g)!;
    const original = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/fonts/plex.css")], minify: true });
    expect(original.success).toBe(true);
    const declarations = (value: string) => value.replace(/src:(?:url\([^)]*\)format\([^)]*\),?)+;/g, "");
    expect(declarations(css)).toBe(declarations(await original.outputs[0]!.text()));
    for (const face of faces) {
      expect(face).toContain("font-display:swap");
      expect(face).toContain("unicode-range:");
      const url = face.match(/url\(([^)]+)\)/)![1]!;
      expect(url).toMatch(/-[a-f0-9]{16}\.woff2$/);
      const bytes = await readFile(resolve(directory, url));
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
    }
    for (const family of ["IBM Plex Sans", "IBM Plex Mono"]) {
      expect(css).toContain(`font-family:${family};font-style:italic;font-display:swap;font-weight:400`);
      expect(css).toContain(`font-family:${family};font-style:normal;font-display:swap;font-weight:600`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
