/**
 * SVG avatar generation and WebP data URL parsing utilities.
 *
 * Provides a deterministic, color-coded SVG avatar generator for user
 * profile fallbacks and a helper for extracting raw image data from
 * base64-encoded WebP data URLs.
 *
 * @example
 * import { svg } from "@k2b/stdlib";
 *
 * const avatar = svg.generateAvatar("user-123", "JD");
 * const webpData = svg.parseWebpDataUrl(dataUrl);
 */

import { fromBase64 } from "./encoding";

// ==========================
// Internal Helpers
// ==========================

const USER_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#6366f1",
  "#a855f7",
];

/**
 * Selects a deterministic color from the palette based on a string identifier.
 *
 * Uses a simple hash (multiply-by-31 and accumulate char codes) to map any
 * string to a consistent index in the {@link USER_COLORS} array. The same
 * `id` always produces the same color.
 *
 * @param id - Unique identifier to derive the color from
 * @returns CSS hex color string (e.g. `"#3b82f6"`)
 */
const getUserColor = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length]!;
};

/**
 * Escapes XML-special characters to prevent injection in SVG markup.
 *
 * Replaces `&`, `<`, `>`, and `"` with their corresponding XML entities
 * (`&amp;`, `&lt;`, `&gt;`, `&quot;`).
 *
 * @param s - Raw string to escape
 * @returns XML-safe string
 */
const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ==========================
// Public API
// ==========================

/**
 * Generates a deterministic fallback avatar as a 128x128 SVG image.
 *
 * Creates a colored square with up to two initials centered in white text.
 * The background color is derived from the `id` via {@link getUserColor},
 * ensuring the same user always gets the same color. If `text` is empty,
 * a `"?"` placeholder is used instead.
 *
 * @param id - Unique identifier used for deterministic color selection
 * @param text - Text to extract initials from (first 2 characters, uppercased)
 * @returns `Uint8Array` containing UTF-8 encoded SVG image data
 */
export const generateSvgAvatar = (id: string, text: string): Uint8Array => {
  const initials = escapeXml((text || "?").slice(0, 2).toUpperCase());
  const color = getUserColor(id);

  const svg = `<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" fill="${color}"/>
  <text x="50%" y="50%" dy="0.38em" text-anchor="middle"
        font-family="'JetBrains Mono', monospace"
        font-size="56" font-weight="600" fill="white">
    ${initials}
  </text>
</svg>`;

  return new TextEncoder().encode(svg);
};

/**
 * Extracts raw image data from a base64 WebP data URL.
 *
 * Only accepts data URLs with the exact MIME type `image/webp` and
 * `base64` encoding. Returns `null` if the format does not match
 * (e.g. wrong MIME type, missing prefix, or malformed structure).
 *
 * @param dataUrl - Data URL in format `"data:image/webp;base64,..."`
 * @returns `Uint8Array` with decoded image bytes, or `null` if the format is invalid
 */
export const parseWebpDataUrl = (dataUrl: string): Uint8Array | null => {
  const match = dataUrl.match(/^data:image\/webp;base64,(.+)$/);
  return match ? fromBase64(match[1]!) : null;
};

export const svg = {
  generateAvatar: generateSvgAvatar,
  parseWebpDataUrl,
} as const;
