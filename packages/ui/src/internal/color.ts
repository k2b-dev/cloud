import type { JSX } from "solid-js";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const normalizeHexColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  return color && HEX_COLOR.test(color) ? color : undefined;
};

/**
 * A colour a part puts into a style: a hex colour, a colour name (`blue`, `transparent`), a colour function of plain
 * numbers (`rgb(124, 58, 237)`, `oklch(0.62 0.19 264 / 50%)`) or a custom property of the page (`var(--k2b-action)`).
 * Anything else, such as a value with `;`, `url(` or a second declaration, is dropped: a value from data never
 * adds to the style it stands in, on the server or in the browser.
 */
const CSS_COLOR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+|var\(--[a-z0-9-]+\)|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d.\s,/%+-]|deg|turn|rad)*\))$/i;

export const cssColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  return color && CSS_COLOR.test(color) ? color : undefined;
};

export const hexWithAlpha = (value: string, alpha: string): string => {
  const hex = value.slice(1);
  const expanded = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
  return `#${expanded}${alpha}`;
};

export const colorTintStyle = (value: string | null | undefined): JSX.CSSProperties | undefined => {
  const color = normalizeHexColor(value);
  return color
    ? {
        "--k2b-choice-color": color,
        "--k2b-choice-background": hexWithAlpha(color, "1f"),
      }
    : undefined;
};
