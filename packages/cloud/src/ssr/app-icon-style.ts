import type { AppAppearance } from "../contracts/app";
import { appCanvasTone, appColorSurfaces, mixHex } from "./app-color";

type HexColor = `#${string}`;
type AppIconPaletteEntry = { from: HexColor };
const isHexColor = (value: string | undefined): value is HexColor => /^#[0-9a-f]{6}$/i.test(value ?? "");

const appIconPalette: readonly [AppIconPaletteEntry, ...AppIconPaletteEntry[]] = [
  { from: "#2563eb" },
  { from: "#059669" },
  // Olive, in place of a violet: violet and plum mean AI. Entries keep their places so every app keeps its tone.
  { from: "#4d7c0f" },
  { from: "#d97706" },
  { from: "#e11d48" },
  { from: "#0891b2" },
  // Terracotta, in place of a zinc grey that read as black and fell below 3:1 in dark mode.
  { from: "#c2410c" },
];

const paletteForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % appIconPalette.length;
  return appIconPalette[hash] ?? appIconPalette[0];
};

/** The colour an app declares for its icon: `appearance.iconColor`, else its `accent`. Invalid values count as unset. */
export const declaredIconColor = (appearance: Pick<AppAppearance, "accent" | "iconColor"> | undefined): HexColor | undefined =>
  [appearance?.iconColor, appearance?.accent].find(isHexColor);

/**
 * An app's icon colour: the one it declares (`declaredIconColor`), or a palette tone from its ID. The app grid, the app
 * bar and its editor share it.
 */
export const appIconTone = (app: { id: string; iconColor?: string }): HexColor =>
  isHexColor(app.iconColor) ? app.iconColor : paletteForId(app.id).from;

/** An app's tile colour for the app grid and the app bar editor. */
export const appIconStyle = (app: { id: string; iconColor?: string }) => `--app-icon-color:${appIconTone(app)}`;

/** The 12 % share of an app's colour that fills its tile in the app bar editor (`.rail-editor-tile`). */
const tileShare = 0.12;

/**
 * The app bar editor's tile: the app's colour as its fill and, like the app bar's icons, its glyph in the app's colour
 * held at 3:1 on that fill (`appCanvasTone`).
 */
export const appTileStyle = (app: { id: string; iconColor?: string }) => {
  const tone = appIconTone(app);
  const glyph = appCanvasTone(tone, {
    light: [mixHex(tone, appColorSurfaces.light.surface, tileShare)],
    dark: [mixHex(tone, appColorSurfaces.dark.surface, tileShare)],
  });
  return `--app-icon-color:${tone};--app-tile-ink-light:${glyph.light};--app-tile-ink-dark:${glyph.dark}`;
};
