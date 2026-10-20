import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { mapAttribution, mapStyle } from "./map-style";

const options = {
  theme: "light",
  locale: "de",
  tiles: "/_geo/tiles/{z}/{x}/{y}.pbf",
  glyphs: "/_geo/glyphs/{fontstack}/{range}.pbf",
} as const;
const glyphRoot = resolve(import.meta.dir, "../../map-glyphs");
const symbols = (locale = "de") => mapStyle({ ...options, locale }).layers.filter((layer) => layer.type === "symbol");

describe("mapStyle", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} is a valid, flat OpenMapTiles style`, () => {
      const style = mapStyle({ ...options, theme });
      expect(validateStyleMin(style)).toEqual([]);
      expect(style.glyphs).toBe(options.glyphs);
      expect(style).not.toHaveProperty("sprite");
      expect(style).not.toHaveProperty("terrain");
      expect(style).not.toHaveProperty("sky");
      expect(style.layers.length).toBeGreaterThan(0);
      for (const layer of style.layers) {
        expect(["fill-extrusion", "hillshade", "raster", "sky"]).not.toContain(layer.type);
      }
      expect(Object.keys(style.sources)).toEqual(["openmaptiles"]);
      const source = style.sources.openmaptiles;
      expect(source?.type).toBe("vector");
      if (source?.type !== "vector") throw new Error("Expected vector tiles");
      expect(source.tiles).toEqual([options.tiles]);
      expect(source.maxzoom).toBe(14);
      for (const entry of Object.values(style.sources)) expect(entry.type).not.toBe("raster-dem");
    });
  }

  test.each([
    ["de", "de"],
    ["de-DE", "de"],
    ["en", "en"],
    ["", undefined],
    ["not a locale!", undefined],
    ["123", undefined],
  ])("every symbol follows locale %j", (locale, language) => {
    const layers = symbols(locale);
    expect(layers.length).toBeGreaterThan(0);
    const names: ["get", string][] = [
      ["get", "name:latin"],
      ["get", "name"],
    ];
    if (language) names.unshift(["get", `name:${language}`]);
    for (const layer of layers) expect(layer.layout?.["text-field"]).toEqual(["coalesce", ...names]);
  });

  test("source maxzoom follows the host option", () => {
    expect(mapStyle({ ...options, maxzoom: 16 }).sources.openmaptiles).toMatchObject({ maxzoom: 16 });
    for (const maxzoom of [-1, 1.5, 25]) expect(() => mapStyle({ ...options, maxzoom })).toThrow(RangeError);
  });

  test("each tile and glyph template token is required", () => {
    for (const token of ["{z}", "{x}", "{y}"]) {
      expect(() => mapStyle({ ...options, tiles: options.tiles.replace(token, "0") })).toThrow(TypeError);
    }
    for (const token of ["{fontstack}", "{range}"]) {
      expect(() => mapStyle({ ...options, glyphs: options.glyphs.replace(token, "0") })).toThrow(TypeError);
    }
  });

  test("all label fontstacks ship the subset coverage and licence", async () => {
    const stacks = new Set<string>();
    for (const theme of ["light", "dark"] as const) {
      for (const layer of mapStyle({ ...options, theme }).layers) {
        if (layer.type !== "symbol") continue;
        const fonts = layer.layout?.["text-font"];
        expect(Array.isArray(fonts)).toBe(true);
        if (!Array.isArray(fonts) || !fonts.every((font) => typeof font === "string")) throw new Error("Expected literal fontstack");
        stacks.add(fonts.join(","));
      }
    }
    expect([...stacks]).toEqual(["IBM Plex Sans Medium"]);
    expect(readFileSync(join(glyphRoot, "OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    const require = createRequire(import.meta.url);
    const fontRoot = dirname(require.resolve("@fontsource/ibm-plex-sans/package.json"));
    expect(readFileSync(join(glyphRoot, "OFL.txt"))).toEqual(readFileSync(join(fontRoot, "LICENSE")));
    // The real glyphs of each pinned WOFF subset; Fontsource's unicode-range metadata also names blocks the files do not draw.
    const fontnik: { load(font: Buffer, callback: (error: Error | null, faces: { points: number[] }[]) => void): void } =
      require("fontnik");
    for (const stack of stacks) {
      const directory = join(glyphRoot, stack);
      expect(statSync(directory).isDirectory()).toBe(true);
      for (const start of [0, 256, 512, 768, 1024, 1280, 8192]) {
        expect(statSync(join(directory, `${start}-${start + 255}.pbf`)).size).toBeGreaterThan(0);
      }
      const ranges = new Set(readdirSync(directory));
      for (const subset of ["latin", "latin-ext", "vietnamese", "greek", "cyrillic", "cyrillic-ext"]) {
        const font = readFileSync(join(fontRoot, "files", `ibm-plex-sans-${subset}-500-normal.woff`));
        const faces = await new Promise<{ points: number[] }[]>((done, fail) =>
          fontnik.load(font, (error, loaded) => (error ? fail(error) : done(loaded))),
        );
        const points = faces[0]?.points ?? [];
        expect(points.length, subset).toBeGreaterThan(0);
        for (const point of points) {
          const rangeStart = Math.floor(point / 256) * 256;
          expect(
            ranges.has(`${rangeStart}-${rangeStart + 255}.pbf`),
            `${subset}: U+${point.toString(16)} requires ${rangeStart}-${rangeStart + 255}.pbf`,
          ).toBe(true);
        }
      }
    }
  });

  test("attribution has the three required links in display order", () => {
    expect(mapAttribution).toEqual([
      { href: "https://www.openstreetmap.org/copyright", label: "© OpenStreetMap" },
      { href: "https://openmaptiles.org/", label: "© OpenMapTiles" },
      { href: "https://www.geoapify.com/", label: "Geoapify" },
    ]);
  });

  test("source files contain no provider connection or key; only the attribution URL is allowed", () => {
    const src = resolve(import.meta.dir, "..");
    // Build the forbidden spellings from pieces so this guard also scans itself.
    const provider = ["geo", "apify"].join("");
    const host = new RegExp(`api[-.\\w]*\\.${provider}\\.com`, "i");
    const endpoint = `${provider}.com/v1`;
    const key = ["api", "Key"].join("").toLowerCase();
    const attributionHref = `https://www.${provider}.com/`;
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) {
          const text = readFileSync(path, "utf8");
          expect(text, path).not.toMatch(host);
          expect(text.toLowerCase(), path).not.toContain(endpoint);
          expect(text.toLowerCase(), path).not.toContain(key);
          const remainder = text.replaceAll(attributionHref, "");
          expect(remainder, path).not.toMatch(new RegExp(`${provider}\\.com`, "i"));
        }
      }
    };
    expect(existsSync(src)).toBe(true);
    visit(src);
  });
});
