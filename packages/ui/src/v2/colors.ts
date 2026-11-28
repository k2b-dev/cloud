/**
 * Data colours (a base, a tag, a person, a kind of thing) come from data, so a primitive validates one before it puts
 * it into a style, on the server and in the browser alike: a hex colour, an `oklch()` of plain numbers, a custom
 * property of the page (`var(--name)`), or `light-dark(a, b)` of two such colours, so a colour can keep its contrast in
 * both themes. Anything else is dropped and the primitive stays neutral.
 *
 * For a hex colour the primitive also gets foregrounds that stay readable whatever the colour is: a symbol or a bar
 * keeps 3:1 against its tint (light and dark), and a surface under white type keeps 4.5:1.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const OKLCH = new RegExp(String.raw`^oklch\(\s*${NUMBER}%?\s+${NUMBER}%?\s+${NUMBER}(?:deg)?\s*(?:\/\s*${NUMBER}%?\s*)?\)$`, "i");
const TOKEN = /^var\(--[a-z0-9][a-z0-9-]*\)$/i;
/** `light-dark(` … `)` around exactly one top-level comma; both sides are checked as colours of their own. */
const LIGHT_DARK = /^light-dark\((.*)\)$/i;

const plainColor = (value: string) => HEX.test(value) || OKLCH.test(value) || TOKEN.test(value);

/** The two sides of a `light-dark()`, split at its one comma outside parentheses; nothing when there is not exactly one. */
const sides = (inner: string): [string, string] | undefined => {
  let depth = 0;
  let at = -1;
  for (let index = 0; index < inner.length; index++) {
    const sign = inner[index];
    if (sign === "(") depth++;
    else if (sign === ")") depth--;
    else if (sign === "," && depth === 0) {
      if (at !== -1) return undefined;
      at = index;
    }
    if (depth < 0) return undefined;
  }
  return depth === 0 && at !== -1 ? [inner.slice(0, at).trim(), inner.slice(at + 1).trim()] : undefined;
};

/** The colour when it has one of the accepted forms, else nothing. */
export const safeColor = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (plainColor(trimmed)) return trimmed;
  // a colour for each theme: both sides must be plain colours themselves (no nesting, nothing else)
  const both = LIGHT_DARK.exec(trimmed)?.[1];
  const pair = both === undefined ? undefined : sides(both);
  return pair && plainColor(pair[0]) && plainColor(pair[1]) ? `light-dark(${pair[0]}, ${pair[1]})` : undefined;
};

type Rgb = readonly [number, number, number];

const rgbOf = (hex: string): Rgb | undefined => {
  if (!HEX.test(hex)) return undefined;
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as unknown as Rgb;
};

const hexOf = (rgb: Rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/** `color-mix(in srgb, a share, b)`: the mix the stylesheet draws a tint with. */
const mix = (a: Rgb, share: number, b: Rgb): Rgb => [0, 1, 2].map((index) => a[index]! * share + b[index]! * (1 - share)) as unknown as Rgb;

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The contrast ratio of two colours, 1 to 21. */
export const contrast = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** The colour moved towards `target` in small steps until it has `ratio` against `against`. */
const towards = (color: Rgb, target: Rgb, against: Rgb, ratio: number): Rgb => {
  for (let step = 0; step <= 20; step++) {
    const moved = mix(target, step / 20, color);
    if (contrast(moved, against) >= ratio) return moved;
  }
  return target;
};

/**
 * The lightest step of the colour that still has `ratio` against `surface` (towards the surface while it holds, else
 * away from it): the quieter bars of a history, which must stay readable beside the strong one.
 */
const softest = (color: Rgb, surface: Rgb, away: Rgb, ratio: number): Rgb => {
  if (contrast(color, surface) < ratio) return towards(color, away, surface, ratio);
  let soft = color;
  for (let step = 1; step <= 20; step++) {
    const moved = mix(surface, step / 20, color);
    if (contrast(moved, surface) < ratio) break;
    soft = moved;
  }
  return soft;
};

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** The surfaces of v2 (`--k2-surface`), light and dark, which a tint is mixed with. */
const SURFACE_LIGHT: Rgb = [255, 255, 255];
const SURFACE_DARK: Rgb = [17, 21, 27];
/** The share of the colour in the tint of a mark (`.k2-mk`). */
const TINT = 0.13;

/**
 * The style values of a data colour: the colour itself as `--k2-c`, and for a hex colour its readable foregrounds:
 * `--k2-c-fg` / `--k2-c-fg-dark` (a symbol, 3:1 against its tint), `--k2-c-soft` / `--k2-c-soft-dark` (the quieter
 * bars of a history, as light as 3:1 against the surface allows) and `--k2-c-ink` / `--k2-c-ink-dark` (4.5:1: white type
 * on it, and the strongest bar).
 */
export const colorStyle = (value: string | undefined): Record<string, string> | undefined => {
  const color = safeColor(value);
  if (color === undefined) return undefined;
  const rgb = rgbOf(color);
  if (!rgb) return { "--k2-c": color };
  return {
    "--k2-c": color,
    "--k2-c-fg": hexOf(towards(rgb, BLACK, mix(rgb, TINT, SURFACE_LIGHT), 3)),
    "--k2-c-fg-dark": hexOf(towards(rgb, WHITE, mix(rgb, TINT, SURFACE_DARK), 3)),
    "--k2-c-soft": hexOf(softest(rgb, SURFACE_LIGHT, BLACK, 3)),
    "--k2-c-soft-dark": hexOf(softest(rgb, SURFACE_DARK, WHITE, 3)),
    "--k2-c-ink": hexOf(towards(rgb, BLACK, WHITE, 4.5)),
    "--k2-c-ink-dark": hexOf(towards(rgb, WHITE, SURFACE_DARK, 4.5)),
  };
};

/** A value for a custom property that cannot end its declaration or open another one. */
export const safeValue = (value: string) => !/[;{}<>\\]/.test(value);
