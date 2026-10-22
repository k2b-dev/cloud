type HexColor = `#${string}`;

const minimumContrast = 4.5;
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

/** WCAG 2.x relative luminance from a six-digit sRGB hex color. */
export const relativeLuminance = (hex: HexColor): number => {
  const linearize = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
};

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
    const toward = theme === "light" ? "#000000" : "#ffffff";
    let ink: HexColor = toward;
    for (let i = 100; i >= 0; i--) {
      const candidate = mixHex(accent, toward, i / 100);
      if (backgrounds.every((background) => contrastRatio(candidate, background) >= minimumContrast)) {
        ink = candidate;
        break;
      }
    }
    return { ink, selected, selectedNav, shellSelected };
  };
  return { light: forTheme("light"), dark: forTheme("dark") };
};

/** Plain hex declarations for server-rendered app appearance and accent scopes. */
export const appColorStyle = (accent: HexColor): string => {
  const { light, dark } = appColors(accent);
  return `--app-ink-light:${light.ink};--app-ink-dark:${dark.ink};--app-selected-light:${light.selected};--app-selected-dark:${dark.selected};--app-selected-nav-light:${light.selectedNav};--app-selected-nav-dark:${dark.selectedNav}`;
};
