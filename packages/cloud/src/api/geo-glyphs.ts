import { appAssetPath } from "../server/app-assets";

declare const __CLOUD_APP_ASSETS__: string | undefined;

/** The route validates the font and range before resolving a bundled asset. */
export const geoGlyphFile = (font: string, range: string) =>
  Bun.file(
    typeof __CLOUD_APP_ASSETS__ === "string"
      ? appAssetPath("map-glyphs", font, range)
      : new URL(`./map-glyphs/${encodeURIComponent(font)}/${range}`, import.meta.resolve("@k2b/ui/package.json")),
  );
