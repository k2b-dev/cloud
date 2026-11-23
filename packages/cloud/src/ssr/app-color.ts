type HexColor = `#${string}`;

const minimumContrast = 4.5;
/** WCAG 1.4.11: icons and other graphics need 3:1 against what is next to them. */
const graphicContrast = 3;
const fillShares = {
  light: { selected: 0.07, selectedNav: 0.1 },
  dark: { selected: 0.14, selectedNav: 0.17 },
} as const;

/**
 * Opaque theme backgrounds checked for readable app ink; a test pins them to
 * tokens.css and @k2b/ui. `sidebar` is the workspace sidebar's own background
 * (`--k2b-surface` since the one-surface workspace); a test reads that
 * declaration from @k2b/ui. `sidebarHover` is its row hover over it; `subtle`,
 * `muted`, `hover`, and `platformSelected` are the `--ui-surface-subtle`,
 * `--ui-surface-muted`, `--ui-hover`, and blue `--ui-selected` fills app ink
 * also sits on.
 */
export const appColorSurfaces = {
  light: {
    canvas: "#fafafa",
    surface: "#ffffff",
    sidebar: "#ffffff",
    sidebarHover: "#f3f3f3",
    subtle: "#f8f8f8",
    muted: "#f3f4f3",
    raised: "#ffffff",
    hover: "#f0f1f0",
    platformSelected: "#f0f6ff",
  },
  dark: {
    canvas: "#090d12",
    surface: "#11151b",
    sidebar: "#11151b",
    sidebarHover: "#1d2026",
    subtle: "#161a20",
    muted: "#20242a",
    raised: "#181d24",
    hover: "#252c35",
    platformSelected: "#192636",
  },
} as const;

const channels = (hex: HexColor) =>
  [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)] as const;

/** WCAG 2.x relative luminance of sRGB channels from 0 to 255, also between whole values. */
const channelLuminance = ([r, g, b]: readonly [number, number, number]): number => {
  const linearize = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
};

/** WCAG 2.x relative luminance from a six-digit sRGB hex color. */
export const relativeLuminance = (hex: HexColor): number => channelLuminance(channels(hex));

/** WCAG 2.x contrast ratio between two opaque hex colors. */
export const contrastRatio = (a: HexColor, b: HexColor): number => {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

/** Rounded sRGB channel mix, with share indicating the fraction of a. */
export const mixHex = (a: HexColor, b: HexColor, share: number): HexColor => {
  const second = channels(b);
  const fraction = Math.max(0, Math.min(1, share));
  return `#${channels(a)
    .map((value, index) =>
      Math.round(value * fraction + second[index]! * (1 - fraction))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/**
 * The mildest whole-percent step from `accent` toward black (light) or white (dark) that keeps `minimum` contrast
 * against every background; the end color when no step does. A passing accent stays as it is.
 */
export const readableTone = (
  accent: HexColor,
  backgrounds: readonly HexColor[],
  theme: keyof typeof appColorSurfaces,
  minimum: number,
): HexColor => {
  const toward = theme === "light" ? "#000000" : "#ffffff";
  for (let i = 100; i >= 0; i--) {
    const candidate = mixHex(accent, toward, i / 100);
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= minimum)) return candidate;
  }
  return toward;
};

/**
 * "Color on the canvas": an app's color for a mark that lies directly on a tinted ground, such as its icon in the
 * app bar. Darkened in light and lightened in dark until it keeps the 3:1 of graphics against every ground given.
 */
export const appCanvasTone = (accent: HexColor, grounds: Record<keyof typeof appColorSurfaces, readonly HexColor[]>) => ({
  light: readableTone(accent, grounds.light, "light", graphicContrast),
  dark: readableTone(accent, grounds.dark, "dark", graphicContrast),
});

/** Derive selection fills, the shell's open-app fill, and the nearest AA-readable app ink in each theme. */
export const appColors = (accent: HexColor) => {
  const forTheme = (theme: keyof typeof appColorSurfaces) => {
    const surfaces = appColorSurfaces[theme];
    const selected = mixHex(accent, surfaces.surface, fillShares[theme].selected);
    const selectedNav = mixHex(accent, surfaces.sidebar, fillShares[theme].selectedNav);
    // Cloud's shell marks the open app on its app-colored bar (global.css):
    // with the surface in light, and in dark with the navigation share over the
    // muted surface, which stays apart from the dark bar.
    const shellSelected = theme === "light" ? surfaces.surface : mixHex(accent, surfaces.muted, fillShares.dark.selectedNav);
    const backgrounds = [...Object.values(surfaces), selected, selectedNav, shellSelected];
    return { ink: readableTone(accent, backgrounds, theme, minimumContrast), selected, selectedNav, shellSelected };
  };
  return { light: forTheme("light"), dark: forTheme("dark") };
};

/**
 * The grounds app ink stands on in a `@k2b/ui` v2 page: the v2 surface, and the app's tint, which v2 mixes as
 * `color-mix(in srgb, accent <tint>, surface)`. A test reads both from `@k2b/ui/v2.css`, so a change there fails here.
 */
export const v2InkGrounds = {
  light: { surface: "#ffffff", tint: 0.08 },
  dark: { surface: "#11151b", tint: 0.28 },
} as const satisfies Record<keyof typeof appColorSurfaces, { surface: HexColor; tint: number }>;

/**
 * Contrast of `color` against `color-mix(in srgb, a share, b)` as the browser paints it: unrounded, so a tone that just
 * passes against the rounded hex of the mix cannot fall below the minimum on screen.
 */
export const contrastOnMix = (color: HexColor, a: HexColor, b: HexColor, share: number): number => {
  const first = channels(a);
  const second = channels(b);
  const mixed = first.map((value, index) => value * share + second[index]! * (1 - share)) as [number, number, number];
  const mixLuminance = channelLuminance(mixed);
  const own = relativeLuminance(color);
  return (Math.max(own, mixLuminance) + 0.05) / (Math.min(own, mixLuminance) + 0.05);
};

/**
 * The v2 app ink of each theme: the mildest whole-percent step of the accent toward black (light) or white (dark) that
 * keeps 4.5:1 on the v2 surface and on the app's tint; the end color when no step does.
 */
export const appV2Ink = (accent: HexColor) => {
  const forTheme = (theme: keyof typeof v2InkGrounds): HexColor => {
    const { surface, tint } = v2InkGrounds[theme];
    const toward = theme === "light" ? "#000000" : "#ffffff";
    for (let i = 100; i >= 0; i--) {
      const candidate = mixHex(accent, toward, i / 100);
      if (contrastRatio(candidate, surface) >= minimumContrast && contrastOnMix(candidate, accent, surface, tint) >= minimumContrast)
        return candidate;
    }
    return toward;
  };
  return { light: forTheme("light"), dark: forTheme("dark") };
};

/** Plain hex declarations for server-rendered app appearance and accent scopes. */
export const appColorStyle = (accent: HexColor): string => {
  const { light, dark } = appColors(accent);
  return `--app-ink-light:${light.ink};--app-ink-dark:${dark.ink};--app-selected-light:${light.selected};--app-selected-dark:${dark.selected};--app-selected-nav-light:${light.selectedNav};--app-selected-nav-dark:${dark.selectedNav}`;
};
