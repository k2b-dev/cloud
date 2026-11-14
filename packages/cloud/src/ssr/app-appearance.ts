import type { AppAppearance } from "../contracts/app";
import { appCanvasTone, appColorStyle, appColorSurfaces, mixHex } from "./app-color";
import { resolveRuntimeRoute } from "./app-navigation";
import { helpPageAppId } from "./layout-help-url";
import type { RuntimeContext } from "./runtime";

type HexColor = `#${string}`;
const isHexColor = (value: string | undefined): value is HexColor => /^#[0-9a-f]{6}$/i.test(value ?? "");
const clampStrength = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value ?? fallback)) : fallback;

/** The canvas an appearance paints (global.css `.cloud-app-canvas`), with the same fallbacks and clamps. */
const resolveAppCanvas = (appearance: AppAppearance) => {
  const from = isHexColor(appearance.background?.from) ? appearance.background.from : appearance.accent;
  const to = isHexColor(appearance.background?.to) ? appearance.background.to : from;
  const via = isHexColor(appearance.background?.via) ? appearance.background.via : "#ffffff";
  const angle = Number.isFinite(appearance.background?.angle) ? Math.max(0, Math.min(360, appearance.background?.angle ?? 135)) : 135;
  const strength = clampStrength(appearance.background?.strength, 20);
  return { from, via, to, angle, strength, darkStrength: Math.round(strength / 2) };
};

export const appAppearanceStyle = (appearance: AppAppearance | undefined): string | undefined => {
  if (!isHexColor(appearance?.accent)) return undefined;
  const { from, via, to, angle, strength, darkStrength } = resolveAppCanvas(appearance);
  return `--app-accent:${appearance.accent};${appColorStyle(appearance.accent)};--app-canvas-from:${from};--app-canvas-via:${via};--app-canvas-to:${to};--app-canvas-angle:${angle}deg;--app-canvas-strength:${strength}%;--app-canvas-dark-strength:${darkStrength}%`;
};

/**
 * Colors global.css paints the app bar's grounds with; app-appearance.test.ts pins them to the tokens. `shell` is the
 * neutral tint of the tablet bar on a page without an app color (`--color-zinc-400`), `text` the ink of the sidebar's
 * hover (`--k2b-text`), `hover` the narrow bar's `--ui-hover`, and `surface` the tablet bar's hover (`--k2b-surface`).
 */
export const appBarTokens = {
  light: {
    canvas: appColorSurfaces.light.canvas,
    shell: "#9f9fa9",
    text: "#09090b",
    hover: "#eff0ef",
    hoverShare: 0.9,
    surface: "#ffffff",
  },
  dark: { canvas: appColorSurfaces.dark.canvas, shell: "#9f9fa9", text: "#fafafa", hover: "#252c35", hoverShare: 1, surface: "#11151b" },
} as const;

/** Shares of the tablet bar's own gradient (global.css `--cloud-shell-gradient`). */
const shellShares = { light: { edge: 0.34, via: 0.16 }, dark: { edge: 0.22, via: 0.12 } } as const;

/**
 * Every opaque ground the app bar's entries lie on while a page of `appearance` is open: the canvas gradient's three
 * stops (from 1024 px), the tablet bar's own gradient (768 to 1023 px), and the hover fills of the narrow, wide, and
 * tablet bars over them. A page without an app color has the neutral canvas.
 */
export const appBarGrounds = (appearance: AppAppearance | undefined) => {
  const canvas = isHexColor(appearance?.accent) ? resolveAppCanvas(appearance) : undefined;
  const forTheme = (theme: "light" | "dark") => {
    const tokens = appBarTokens[theme];
    const share = canvas ? (theme === "light" ? canvas.strength : canvas.darkStrength) / 100 : 0;
    const stops: HexColor[] = canvas
      ? [
          mixHex(canvas.from, tokens.canvas, share),
          theme === "light" ? mixHex(canvas.via, tokens.canvas, share) : tokens.canvas,
          mixHex(canvas.to, tokens.canvas, share),
        ]
      : [tokens.canvas];
    const shellFrom = canvas?.from ?? tokens.shell;
    const shellTo = canvas?.to ?? tokens.shell;
    const shell: HexColor[] = [
      mixHex(shellFrom, tokens.canvas, shellShares[theme].edge),
      mixHex(mixHex(shellFrom, shellTo, 0.45), tokens.canvas, shellShares[theme].via),
      mixHex(shellTo, tokens.canvas, shellShares[theme].edge),
    ];
    return [
      ...stops,
      ...stops.map((ground) => mixHex(tokens.hover, ground, tokens.hoverShare)),
      ...stops.map((ground) => mixHex(tokens.text, ground, 0.05)),
      ...shell,
      ...shell.map((ground) => mixHex(tokens.surface, ground, 0.45)),
    ];
  };
  return { light: forTheme("light"), dark: forTheme("dark") };
};

/** An app's icon color in the app bar, on every ground of `grounds` (see `appBarGrounds`). */
export const appBarIconStyle = (tone: string | undefined, grounds: ReturnType<typeof appBarGrounds>): string | undefined => {
  if (!isHexColor(tone)) return undefined;
  const { light, dark } = appCanvasTone(tone, grounds);
  return `--app-bar-icon-light:${light};--app-bar-icon-dark:${dark}`;
};

export const appAccentStyle = (accent: string | undefined): string | undefined =>
  isHexColor(accent) ? `--app-accent:${accent};${appColorStyle(accent)}` : undefined;

/** Core's full-page Help of an app belongs to that app. */
export const resolveCurrentApp = (apps: RuntimeContext["apps"], pathname: string) => {
  const helpAppId = helpPageAppId(pathname);
  return apps.find((app) => app.id === helpAppId) ?? resolveRuntimeRoute(apps, pathname)?.app;
};
