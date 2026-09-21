const textFontFiles = [
  "ibm-plex-sans-latin-400-normal.woff2",
  "ibm-plex-sans-latin-500-normal.woff2",
  "ibm-plex-sans-latin-600-normal.woff2",
  "ibm-plex-mono-latin-400-normal.woff2",
  "ibm-plex-mono-latin-500-normal.woff2",
] as const;

const displayFontFile = "instrument-sans-latin-wght-normal.woff2";

export const renderFontPreloads = (assets: string, includeDisplayFont = false) =>
  [...(includeDisplayFont ? [displayFontFile] : []), ...textFontFiles]
    .map((filename) => `<link rel="preload" href="${assets}/fonts/${filename}" as="font" type="font/woff2" crossorigin>`)
    .join("\n    ");
