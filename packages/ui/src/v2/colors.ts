/**
 * Data colours (a base, a tag, a person, a kind of thing) come from data, so a primitive validates one before it puts
 * it into a style, on the server and in the browser alike: a hex colour, an `oklch()` of plain numbers, or a custom
 * property of the page (`var(--name)`). Anything else is dropped and the primitive stays neutral.
 *
 * For a hex colour the primitive also gets foregrounds that stay readable whatever the colour is: a symbol or a bar
 * keeps 3:1 against its tint (light and dark), and a surface under white type keeps 4.5:1.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const OKLCH = new RegExp(String.raw`^oklch\(\s*${NUMBER}%?\s+${NUMBER}%?\s+${NUMBER}(?:deg)?\s*(?:\/\s*${NUMBER}%?\s*)?\)$`, "i");
const TOKEN = /^var\(--[a-z0-9][a-z0-9-]*\)$/i;

/** The colour when it has one of the accepted forms, else nothing. */
export const safeColor = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return HEX.test(trimmed) || OKLCH.test(trimmed) || TOKEN.test(trimmed) ? trimmed : undefined;
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

/** The share of the owner's colour in its tint: 7 % light (identity B, the study's `--app-tint`), 18 % dark (Y's rows, #4355). */
const OWNER_TINT = 0.07;
const OWNER_TINT_DARK = 0.18;

/**
 * The style values of the colour of the app a content belongs to (`Pane owner`): the colour as `--k2-app`, and for a
 * hex colour, light and dark, all measured against its own tint (the open row, the head), which is the harder ground
 * beside the surface:
 * - `--k2-owner-ink`: its figure and words, 4.5:1;
 * - `--k2-owner-line`: the strong mark of its data (the bar of now, the line of an area), 3:1;
 * - `--k2-owner-soft`: the quiet marks of its data over time (bars, ticks), as light as 3:1 allows.
 * A value that points back to the app's colour (`var(--k2-app…)`) is no owner: it would name itself.
 */
export const ownerStyle = (value: string | undefined): Record<string, string> | undefined => {
  const color = safeColor(value);
  if (color === undefined || /^var\(--k2-app/i.test(color)) return undefined;
  const rgb = rgbOf(color);
  if (!rgb) return { "--k2-app": color };
  const tint = mix(rgb, OWNER_TINT, SURFACE_LIGHT);
  const tintDark = mix(rgb, OWNER_TINT_DARK, SURFACE_DARK);
  return {
    "--k2-app": color,
    "--k2-owner-ink": hexOf(towards(rgb, BLACK, tint, 4.5)),
    "--k2-owner-ink-dark": hexOf(towards(rgb, WHITE, tintDark, 4.5)),
    "--k2-owner-line": hexOf(towards(rgb, BLACK, tint, 3)),
    "--k2-owner-line-dark": hexOf(towards(rgb, WHITE, tintDark, 3)),
    "--k2-owner-soft": hexOf(softest(rgb, tint, BLACK, 3)),
    "--k2-owner-soft-dark": hexOf(softest(rgb, tintDark, WHITE, 3)),
  };
};

/** A value for a custom property that cannot end its declaration or open another one. */
export const safeValue = (value: string) => !/[;{}<>\\]/.test(value);
