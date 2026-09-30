/// <reference path="../types/k2b-ui-fonts.d.ts" />
import plexPreset from "@k2b/ui/fonts/plex.css" with { type: "text" };

/**
 * Preload tags for the IBM Plex Sans faces that every page sets in its first
 * frame: Latin text at 400, 500 (buttons, labels) and 600 (headings).
 *
 * The preset declares its faces with `font-display: swap`. Without a preload
 * the browser requests a face only when layout needs it, paints the fallback
 * font and re-wraps the text once Plex arrives. That moves every box after the
 * first changed line, and on a vertically centered page such as sign-in the
 * whole form. Preloaded, the faces download next to the render-blocking
 * stylesheets and the first frame already uses them.
 *
 * Core serves the faces under `/public/fonts/` with the preset's
 * content-hashed file names (`packages/core/scripts/font-assets.ts`). The
 * preset is bundled as text, so production servers need no `node_modules`.
 */
export const FONT_PRELOAD_LINKS = ["400", "500", "600"]
  .map((weight) => {
    const file = new RegExp(`url\\(\\./fonts/(ibm-plex-sans-latin-${weight}-normal-[0-9a-f]+\\.woff2)\\)`).exec(plexPreset)?.[1];
    if (!file) throw new Error(`The @k2b/ui Plex preset has no Latin IBM Plex Sans ${weight} face`);
    return `<link rel="preload" href="/public/fonts/${file}" as="font" type="font/woff2" crossorigin>`;
  })
  .join("\n    ");
