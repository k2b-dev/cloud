import { appCanvasTone, appColorSurfaces, mixHex } from "./app-color";

type HexColor = `#${string}`;
type AppIconPaletteEntry = { from: HexColor };
const isHexColor = (value: string | undefined): value is HexColor => /^#[0-9a-f]{6}$/i.test(value ?? "");

const appIconPalette: readonly [AppIconPaletteEntry, ...AppIconPaletteEntry[]] = [
  { from: "#2563eb" },
  { from: "#059669" },
  { from: "#7c3aed" },
  { from: "#d97706" },
  { from: "#e11d48" },
  { from: "#0891b2" },
  { from: "#52525b" },
];

const paletteForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % appIconPalette.length;
  return appIconPalette[hash] ?? appIconPalette[0];
};

/** An app's own colour: its accent, or a palette tone from its ID. The app grid, the app bar and its editor share it. */
export const appIconTone = (app: { id: string; accent?: string }): HexColor =>
  isHexColor(app.accent) ? app.accent : paletteForId(app.id).from;

/** An app's tile colour for the app grid and the app bar editor. */
export const appIconStyle = (app: { id: string; accent?: string }) => `--app-icon-color:${appIconTone(app)}`;

/** The 12 % share of an app's colour that fills its tile in the app bar editor (`.rail-editor-tile`). */
const tileShare = 0.12;

/**
 * The app bar editor's tile: the app's colour as its fill and, like the app bar's icons, its glyph in the app's colour
 * held at 3:1 on that fill (`appCanvasTone`).
 */
export const appTileStyle = (app: { id: string; accent?: string }) => {
  const tone = appIconTone(app);
  const glyph = appCanvasTone(tone, {
    light: [mixHex(tone, appColorSurfaces.light.surface, tileShare)],
    dark: [mixHex(tone, appColorSurfaces.dark.surface, tileShare)],
  });
  return `--app-icon-color:${tone};--app-tile-ink-light:${glyph.light};--app-tile-ink-dark:${glyph.dark}`;
};
