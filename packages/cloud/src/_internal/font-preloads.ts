/// <reference path="../types/k2b-ui-fonts.d.ts" />
import plexPreset from "@k2b/ui/fonts/plex.css" with { type: "text" };

/**
 * Preload tags for the IBM Plex Sans faces that every page sets in its first
 * frame: Latin text at 400, 500 (list titles, medium text) and 600 (headings,
 * buttons, labels).
 *
 * Core serves the faces with `font-display: optional`
 * (`packages/core/scripts/font-assets.ts`): a face that misses the first frame
 * never replaces the fallback on that page, so a late face cannot re-wrap text
 * or change a button's width. Without a preload the browser requests a face
 * only when layout needs it, too late for the first frame, and a first visit
 * would stay in the fallback font. Preloaded, the faces download next to the
 * render-blocking stylesheets and the first frame already uses them.
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
