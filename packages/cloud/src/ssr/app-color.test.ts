import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appIds } from "../../../../scripts/workspace";
import { appColors, appColorStyle, appColorSurfaces, contrastRatio, mixHex, relativeLuminance } from "./app-color";

type HexColor = `#${string}`;
const workspaceRoot = resolve(import.meta.dir, "../../../..");
const tokens = readFileSync(resolve(import.meta.dir, "../styles/tokens.css"), "utf8");
const uiStyles = readFileSync(resolve(workspaceRoot, "packages/ui/src/styles/index.css"), "utf8");
const tailwindTheme = readFileSync(resolve(workspaceRoot, "node_modules/tailwindcss/theme.css"), "utf8");
const themes = ["light", "dark"] as const;

const declarations = (body: string) =>
  new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key!, value!.trim()]));
const firstBlock = (source: string, selector: string) => {
  const body = source.match(new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`))?.[1];
  if (!body) throw new Error(`Missing first ${selector} block`);
  return declarations(body);
};
const themeTokens = { light: firstBlock(tokens, ":root"), dark: firstBlock(tokens, "\\.dark") };
// @k2b/ui's own roles; its dark block (the last line of its selector list) inherits the rest.
const uiLight = firstBlock(uiStyles, "\\.k2b-ui");
const uiTokens = { light: uiLight, dark: new Map([...uiLight, ...firstBlock(uiStyles, "\\.dark \\.k2b-ui")]) };
const tailwindTokens = declarations(tailwindTheme);

const required = (values: Map<string, string>, name: string) => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing color token ${name}`);
  return value;
};
const toHex = (channels: number[]): HexColor =>
  `#${channels
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const toChannels = (hex: HexColor) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

/**
 * Resolve only the color forms used by the surface tokens; unknown forms must
 * fail. `transparent` resolves to `base`, the surface a translucent mix sits on.
 */
const resolveColor = (value: string, theme: (typeof themes)[number], base?: HexColor): HexColor => {
  if (/^#[\da-f]{6}$/i.test(value)) return `#${value.slice(1).toLowerCase()}`;
  if (value === "transparent" && base) return base;
  const variable = value.match(/^var\((--(?:ui|color|k2b)-[\w-]+)\)$/);
  if (variable) {
    const name = variable[1]!;
    const source = name.startsWith("--color-") ? tailwindTokens : name.startsWith("--k2b-") ? uiTokens[theme] : themeTokens[theme];
    return resolveColor(required(source, name), theme, base);
  }
  const rgb = value.match(/^rgb\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) \/ (\d*\.?\d+)\)$/);
  if (rgb) {
    const alpha = Number(rgb[4]);
    const canvas = toChannels(resolveColor(required(themeTokens[theme], "--ui-canvas"), theme));
    return toHex(rgb.slice(1, 4).map((channel, index) => Number(channel) * alpha + canvas[index]! * (1 - alpha)));
  }
  const mix = value.match(/^color-mix\(in srgb, (.+) ([\d.]+)%, (.+)\)$/);
  if (mix) {
    const a = toChannels(resolveColor(mix[1]!, theme, base));
    const b = toChannels(resolveColor(mix[3]!, theme, base));
    const share = Number(mix[2]) / 100;
    return toHex(a.map((channel, index) => channel * share + b[index]! * (1 - share)));
  }
  const oklch = value.match(/^oklch\(([\d.]+)% ([\d.]+|none) ([\d.]+|none)\)$/);
  if (oklch) {
    const lightness = Number(oklch[1]) / 100;
    const chroma = oklch[2] === "none" ? 0 : Number(oklch[2]);
    const hue = ((oklch[3] === "none" ? 0 : Number(oklch[3])) * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return toHex(
      [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ].map((channel) => 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055)),
    );
  }
  throw new Error(`Unsupported ${theme} surface color: ${value}`);
};

describe("app colors", () => {
  test("all built-in and edge accents have AA ink against every theme and selection surface", () => {
    const builtIn = appIds().flatMap((id) => {
      const config = readFileSync(resolve(workspaceRoot, `packages/${id}/src/config.ts`), "utf8");
      const accent = config.match(/\baccent:\s*["'](#[\da-f]{6})["']/i)?.[1];
      return accent ? [{ id, accent: `#${accent.slice(1)}` satisfies HexColor }] : [];
    });
    expect(builtIn.length).toBeGreaterThan(0);
    expect(builtIn).toContainEqual({ id: "notebooks", accent: "#eab308" });
    const accents: HexColor[] = [
      ...builtIn.map(({ accent }) => accent),
      "#ffff00",
      "#ffffff",
      "#000000",
      "#808080",
      resolveColor("var(--color-blue-500)", "light"),
    ];
    for (const accent of accents) {
      const colors = appColors(accent);
      for (const theme of themes) {
        const { ink, selected, selectedNav } = colors[theme];
        for (const color of [ink, selected, selectedNav]) expect(color).toMatch(/^#[\da-f]{6}$/);
        for (const [name, bg] of Object.entries({ ...appColorSurfaces[theme], selected, selectedNav })) {
          expect(contrastRatio(ink, bg), `${accent}/${theme}/${name} (${bg}), ink ${ink}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("uses WCAG 2.x sRGB luminance and contrast", () => {
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(relativeLuminance("#0a0a0a")).toBeCloseTo(10 / 255 / 12.92, 10);
    expect(relativeLuminance("#0b0b0b")).toBeCloseTo(((11 / 255 + 0.055) / 1.055) ** 2.4, 10);
  });

  test("mixes rounded sRGB channels with clamped shares and lowercase output", () => {
    expect(mixHex("#FFFFFF", "#000000", 0.5)).toBe("#808080");
    expect(mixHex("#FF0000", "#0000FF", 0.25)).toBe("#4000bf");
    expect(mixHex("#FF0000", "#0000FF", 2)).toBe("#ff0000");
    expect(mixHex("#FF0000", "#0000FF", -1)).toBe("#0000ff");
  });

  test("derives the specified selection fills and ordered plain hex declarations", () => {
    expect(appColorStyle("#14b8a6")).toBe(
      "--app-ink-light:#0d7469;--app-ink-dark:#14b8a6;--app-selected-light:#effaf9;--app-selected-dark:#112c2e;--app-selected-nav-light:#deeeed;--app-selected-nav-dark:#1e3d3f",
    );
    const colors = appColors("#eab308");
    expect(colors.light.selected).toBe(mixHex("#eab308", appColorSurfaces.light.surface, 0.07));
    expect(colors.light.selectedNav).toBe(mixHex("#eab308", appColorSurfaces.light.sidebar, 0.1));
    expect(colors.dark.selected).toBe(mixHex("#eab308", appColorSurfaces.dark.surface, 0.14));
    expect(colors.dark.selectedNav).toBe(mixHex("#eab308", appColorSurfaces.dark.sidebar, 0.17));
  });

  test("preserves passing accents and stops at the mildest passing integer step", () => {
    expect(appColors("#1d4ed8").light.ink).toBe("#1d4ed8");
    for (const theme of themes) {
      const accent = "#eab308";
      const { ink, selected, selectedNav } = appColors(accent)[theme];
      const toward = theme === "light" ? "#000000" : "#ffffff";
      const backgrounds = [...Object.values(appColorSurfaces[theme]), selected, selectedNav];
      expect(ink).not.toBe("#000000");
      expect(ink).not.toBe("#ffffff");
      let step = 100;
      while (step >= 0 && mixHex(accent, toward, step / 100) !== ink) step--;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(backgrounds.every((bg) => contrastRatio(ink, bg) >= 4.5)).toBe(true);
      if (step < 100) {
        const previous = mixHex(accent, toward, (step + 1) / 100);
        expect(backgrounds.some((bg) => contrastRatio(previous, bg) < 4.5)).toBe(true);
      } else expect(ink).toBe(accent);
    }
    // Exercise a dark-mode clamp too: yellow already passes unchanged there.
    const { ink, selected, selectedNav } = appColors("#000000").dark;
    const backgrounds = [...Object.values(appColorSurfaces.dark), selected, selectedNav];
    let step = 100;
    while (step >= 0 && mixHex("#000000", "#ffffff", step / 100) !== ink) step--;
    expect(step).toBeGreaterThanOrEqual(0);
    expect(step).toBeLessThan(100);
    expect(backgrounds.some((bg) => contrastRatio(mixHex("#000000", "#ffffff", (step + 1) / 100), bg) < 4.5)).toBe(true);
  });

  test("surface constants match the resolved Cloud and @k2b/ui surfaces", () => {
    const surfaceTokens = [
      ["canvas", "--ui-canvas"],
      ["surface", "--ui-surface"],
      ["subtle", "--ui-surface-subtle"],
      ["muted", "--ui-surface-muted"],
      ["raised", "--ui-surface-raised"],
      ["hover", "--ui-hover"],
      ["platformSelected", "--ui-selected"],
    ] as const;
    for (const theme of themes) {
      const surfaces = appColorSurfaces[theme];
      for (const [surface, token] of surfaceTokens) {
        expect(resolveColor(required(themeTokens[theme], token), theme), `${theme}/${token}`).toBe(surfaces[surface]);
      }
      // The @k2b/ui workspace sidebar and its row hover, laid over that sidebar.
      expect(resolveColor("var(--k2b-surface-muted)", theme), `${theme}/--k2b-surface-muted`).toBe(surfaces.sidebar);
      expect(resolveColor("var(--k2b-app-workspace-hover)", theme, surfaces.sidebar), `${theme}/--k2b-app-workspace-hover`).toBe(
        surfaces.sidebarHover,
      );
    }
  });

  test("platform defaults match the colors computed for Tailwind's blue-500", () => {
    const colors = appColors(resolveColor("var(--color-blue-500)", "light"));
    for (const theme of themes) {
      for (const [name, value] of Object.entries({
        ink: colors[theme].ink,
        selected: colors[theme].selected,
        "selected-nav": colors[theme].selectedNav,
      })) {
        expect(required(themeTokens.light, `--app-${name}-${theme}`)).toBe(value);
      }
    }
  });
});
