type AppIconPaletteEntry = { from: string };

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

/** An app's tile colour: its accent, or a palette tone from its ID. The app grid and the app bar editor share it. */
export const appIconStyle = (app: { id: string; accent?: string }) => {
  const tone = /^#[0-9a-f]{6}$/i.test(app.accent ?? "") ? app.accent! : paletteForId(app.id).from;
  return `--app-icon-color:${tone}`;
};
