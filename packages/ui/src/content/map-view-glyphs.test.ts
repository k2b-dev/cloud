import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateMapGlyphs } from "./map-view-glyphs";

test("all bundled Cloud glyph ranges pass the same PBF/bitmap validation used before rendering", () => {
  const root = resolve(import.meta.dir, "../../map-glyphs/IBM Plex Sans Medium");
  const files = readdirSync(root).filter((name) => name.endsWith(".pbf"));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const bytes = readFileSync(resolve(root, name));
    expect(() => validateMapGlyphs(Uint8Array.from(bytes).buffer)).not.toThrow();
  }
});

test("missing and malformed glyph ranges cannot pass through to MapLibre's silent fallback", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("<html>Failed glyph</html>"), new Uint8Array([255, 255, 255])])
    expect(() => validateMapGlyphs(bytes.buffer)).toThrow();
  const root = resolve(import.meta.dir, "../../map-glyphs/IBM Plex Sans Medium/0-255.pbf");
  const glyphs = readFileSync(root);
  expect(() => validateMapGlyphs(Uint8Array.from(glyphs.subarray(0, 40)).buffer)).toThrow();
});
