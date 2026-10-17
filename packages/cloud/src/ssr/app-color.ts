type HexColor = `#${string}`;

const minimumContrast = 4.5;
const fillShares = {
  light: { selected: 0.07, selectedNav: 0.1 },
  dark: { selected: 0.14, selectedNav: 0.17 },
} as const;

/**
 * Opaque theme backgrounds checked for readable app ink; tests pin these to
 * tokens.css. `sidebar` is `--ui-surface-subtle`, `hover` is `--ui-hover`, and
 * `platformSelected` is the blue `--ui-selected` fill some app ink sits on.
 */
export const appColorSurfaces = {
  light: {
    canvas: "#fafafa",
    surface: "#ffffff",
    sidebar: "#f8f8f8",
    muted: "#f3f4f3",
    raised: "#ffffff",
    hover: "#f0f1f0",
    platformSelected: "#f0f6ff",
  },
  dark: {
    canvas: "#090d12",
    surface: "#11151b",
    sidebar: "#161a20",
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

/** Derive selection fills and the nearest AA-readable app ink in each theme. */
export const appColors = (accent: HexColor) => {
  const forTheme = (theme: keyof typeof appColorSurfaces) => {
    const surfaces = appColorSurfaces[theme];
    const selected = mixHex(accent, surfaces.surface, fillShares[theme].selected);
    const selectedNav = mixHex(accent, surfaces.sidebar, fillShares[theme].selectedNav);
    const backgrounds = [...Object.values(surfaces), selected, selectedNav];
    const toward = theme === "light" ? "#000000" : "#ffffff";
    let ink: HexColor = toward;
    for (let i = 100; i >= 0; i--) {
      const candidate = mixHex(accent, toward, i / 100);
      if (backgrounds.every((background) => contrastRatio(candidate, background) >= minimumContrast)) {
        ink = candidate;
        break;
      }
    }
    return { ink, selected, selectedNav };
  };
  return { light: forTheme("light"), dark: forTheme("dark") };
};

/** Plain hex declarations for server-rendered app appearance and accent scopes. */
export const appColorStyle = (accent: HexColor): string => {
  const { light, dark } = appColors(accent);
  return `--app-ink-light:${light.ink};--app-ink-dark:${dark.ink};--app-selected-light:${light.selected};--app-selected-dark:${dark.selected};--app-selected-nav-light:${light.selectedNav};--app-selected-nav-dark:${dark.selectedNav}`;
};
