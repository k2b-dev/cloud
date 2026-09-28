import type { JSX } from "solid-js";

/** WCAG 2 relative luminance of a `#RRGGBB` color. */
const relativeLuminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** WCAG 2 contrast ratio between two `#RRGGBB` colors, from 1 to 21. */
export const contrastRatio = (first: string, second: string): number => {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * The text color for a surface filled with the Venue accent: black or white,
 * whichever contrasts more. One of the two always reaches at least 4.58:1, so
 * text on any accent the admin picks meets WCAG AA.
 */
export const accentForeground = (accent: string): "#000000" | "#ffffff" =>
  contrastRatio(accent, "#000000") > contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff";

/**
 * The two color tokens of a Venue accent. Set them on a surface's root and
 * paint accent fills with `bg-[var(--venue-accent)] text-[var(--venue-on-accent)]`.
 */
export const accentTokens = (accent: string): JSX.CSSProperties => ({
  "--venue-accent": accent,
  "--venue-on-accent": accentForeground(accent),
});
