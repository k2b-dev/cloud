import {
  appTint,
  BLACK,
  contrast,
  hexOf,
  mix,
  type Rgb,
  rgbOf,
  SURFACE_DARK,
  SURFACE_LIGHT,
  safeColor,
  selectedTint,
  WHITE,
} from "./colors";

// A page's own accent (`Workspace accent`): a part of its own, as `NavQuota` and `navTree` are, so a page without one
// loads none of its contrast work (1.1 KB of every island with a Workspace before, #4567).

/** The near-black words of v2 (`--k2-text` in light), the other ink a primary may take besides white. */
const NEAR_BLACK: Rgb = [9, 9, 11];
/** WCAG 1.4.3: type keeps 4.5:1; WCAG 1.4.11: a bar or a symbol keeps 3:1. */
const TEXT = 4.5;
const GRAPHIC = 3;

/** A colour as the screen paints it: whole channels, as `hexOf` writes them. */
const painted = (rgb: Rgb): Rgb => rgb.map((channel) => Math.round(channel)) as unknown as Rgb;

/**
 * The mildest whole-percent step of `color` towards `target` that keeps `ratio` against every ground, judged on the
 * channels it is painted with; `target` itself when no step does.
 */
const readableStep = (color: Rgb, target: Rgb, grounds: readonly Rgb[], ratio: number): Rgb => {
  for (let step = 0; step <= 100; step++) {
    const moved = painted(mix(target, step / 100, color));
    if (grounds.every((ground) => contrast(moved, ground) >= ratio)) return moved;
  }
  return target;
};

/**
 * The lightest tone of `color` (towards the surface, the first ground) that still keeps `ratio` against every ground;
 * moved away from them first if it does not yet.
 */
const quietTone = (color: Rgb, grounds: readonly [Rgb, ...Rgb[]], away: Rgb, ratio: number): Rgb => {
  let quiet = readableStep(color, away, grounds, ratio);
  for (let step = 1; step <= 100; step++) {
    const moved = painted(mix(grounds[0], step / 100, quiet));
    if (grounds.some((ground) => contrast(moved, ground) < ratio)) break;
    quiet = moved;
  }
  return quiet;
};

/**
 * The fill of the primary action and its words: white when it keeps 4.5:1 on the colour, else the near-black of v2
 * when that does; a colour on which neither does (a narrow band of middle tones) is darkened until white does.
 */
const primaryOn = (rgb: Rgb): { fill: Rgb; ink: Rgb } => {
  if (contrast(WHITE, rgb) >= TEXT) return { fill: painted(rgb), ink: WHITE };
  if (contrast(NEAR_BLACK, rgb) >= TEXT) return { fill: painted(rgb), ink: NEAR_BLACK };
  return { fill: readableStep(rgb, BLACK, [WHITE], TEXT), ink: WHITE };
};

/** A hex colour without alpha: the only form whose contrast can be worked out before the page paints. */
const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The style values of a page's own accent (`Workspace accent`), a colour from data: the colour as the app's colour
 * (`--k2-app`, from which the stylesheet mixes the tint), the primary's fill and words (`--k2-primary`,
 * `--k2-primary-ink`, see `primaryOn`), and for each theme the colour as text (`--k2-accent-ink-light` / `-dark`:
 * darkened in light, lightened in dark, until it keeps 4.5:1 on the surface and on the tint), the quiet tone of a bar
 * (`--k2-accent-soft-light` / `-dark`: as light as 3:1 allows on every ground a bar stands on: the surface, the app's
 * tint and the blue tint of a chosen row), and the primary's edge (`--k2-accent-edge-light` / `-dark`: the fill where
 * it keeps 3:1 on the surface, else the mildest step of it that does, so a pale colour still shows its button). Only
 * an opaque hex colour that passes `safeColor` counts; anything else gives nothing, and the app's colour stands.
 */
export const accentStyle = (value: string | undefined): Record<string, string> | undefined => {
  const color = safeColor(value);
  const rgb = color !== undefined && OPAQUE_HEX.test(color) ? rgbOf(color) : undefined;
  if (!rgb) return undefined;
  const { fill, ink } = primaryOn(rgb);
  const tintLight = mix(rgb, appTint.light, SURFACE_LIGHT);
  const tintDark = mix(rgb, appTint.dark, SURFACE_DARK);
  const groundsLight = [SURFACE_LIGHT, tintLight, painted(tintLight), selectedTint.light] as const;
  const groundsDark = [SURFACE_DARK, tintDark, painted(tintDark), selectedTint.dark] as const;
  return {
    "--k2-app": hexOf(rgb),
    "--k2-primary": hexOf(fill),
    "--k2-primary-ink": hexOf(ink),
    "--k2-accent-edge-light": hexOf(readableStep(fill, BLACK, [SURFACE_LIGHT], GRAPHIC)),
    "--k2-accent-edge-dark": hexOf(readableStep(fill, WHITE, [SURFACE_DARK], GRAPHIC)),
    "--k2-accent-ink-light": hexOf(readableStep(rgb, BLACK, [SURFACE_LIGHT, tintLight, painted(tintLight)], TEXT)),
    "--k2-accent-ink-dark": hexOf(readableStep(rgb, WHITE, [SURFACE_DARK, tintDark, painted(tintDark)], TEXT)),
    "--k2-accent-soft-light": hexOf(quietTone(rgb, groundsLight, BLACK, GRAPHIC)),
    "--k2-accent-soft-dark": hexOf(quietTone(rgb, groundsDark, WHITE, GRAPHIC)),
  };
};

/**
 * A page's accent as `pageAccent` worked it out: the style values `Workspace accent` sets (each still passes the
 * Workspace's value guard), and nothing else.
 */
export type PageAccent = { readonly vars: Readonly<Record<string, string>> };

/**
 * The accent of a page from a colour from data (such as the colour a place or a team chose), for `Workspace accent`:
 * its readable tones, worked out where the colour arrives, on the server too, so the first paint is final (see
 * `accentStyle`). Only `#rrggbb` or `#rgb` counts; any other value gives nothing, and the app's colour stands.
 */
export const pageAccent = (color: string | undefined): PageAccent | undefined => {
  const vars = accentStyle(color);
  return vars ? { vars } : undefined;
};
