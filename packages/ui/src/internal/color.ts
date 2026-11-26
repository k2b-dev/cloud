import type { JSX } from "solid-js";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const normalizeHexColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  return color && HEX_COLOR.test(color) ? color : undefined;
};

/** The CSS functions a colour value may use, also nested, such as `color-mix(in srgb, var(--a) 78%, var(--b))`. */
const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
  "var",
]);

/**
 * A colour a part puts into a style: a hex colour, a colour name (`blue`, `transparent`), a custom property of the
 * page, or a colour function from a fixed list, nested as CSS allows (`rgb(124, 58, 237)`, `color-mix(…)`). It holds
 * only letters, digits, `# . , % / -`, spaces and balanced parentheses, and every function is one of that list. Anything
 * else, such as a `;`, a `:`, `url(` or a second declaration, is dropped: a value from data never adds to the style
 * it stands in, on the server or in the browser.
 */
export const cssColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  if (!color || !/^[a-z0-9#.,%/\s()-]+$/i.test(color)) return undefined;
  let depth = 0;
  for (const sign of color) {
    if (sign === "(") depth += 1;
    else if (sign === ")" && --depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  for (const [, name] of color.matchAll(/([a-z-]*)\(/gi)) if (!COLOR_FUNCTIONS.has(name!.toLowerCase())) return undefined;
  return color;
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
