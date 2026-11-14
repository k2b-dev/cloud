import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { httpAppIds } from "../../../../scripts/workspace";
import type { AppAppearance, RuntimeAppMeta } from "../contracts/app";
import { appAccentStyle, appAppearanceStyle, appBarGrounds, appBarIconStyle, resolveCurrentApp } from "./app-appearance";
import { contrastRatio, mixHex } from "./app-color";
import { appIconTone, appTileStyle } from "./app-icon-style";

type HexColor = `#${string}`;
const workspaceRoot = resolve(import.meta.dir, "../../../..");
const globalCss = readFileSync(resolve(import.meta.dir, "../styles/global.css"), "utf8");

const isHex = (value: string | undefined): value is HexColor => /^#[\da-f]{6}$/.test(value ?? "");

/** Each built-in app's declared appearance, read from its config as declared. */
const builtInAppearances = httpAppIds().flatMap((id) => {
  const config = readFileSync(resolve(workspaceRoot, `packages/${id}/src/config.ts`), "utf8");
  const start = config.search(/\bappearance:\s*\{/);
  if (start < 0) return [];
  let depth = 0;
  let end = config.indexOf("{", start);
  for (; end < config.length; end++) {
    if (config[end] === "{") depth++;
    if (config[end] === "}" && --depth === 0) break;
  }
  const block = config.slice(start, end);
  const color = (key: string) => {
    const value = block.match(new RegExp(`\\b${key}:\\s*["'](#[\\da-f]{6})["']`, "i"))?.[1]?.toLowerCase();
    return isHex(value) ? value : undefined;
  };
  const number = (key: string) => Number(block.match(new RegExp(`\\b${key}:\\s*(\\d+)`))?.[1] ?? Number.NaN);
  const accent = color("accent");
  if (!accent) return [];
  const from = color("from");
  const appearance: AppAppearance = {
    accent,
    ...(from
      ? {
          background: {
            from,
            ...(color("via") ? { via: color("via") } : {}),
            ...(color("to") ? { to: color("to") } : {}),
            ...(Number.isFinite(number("angle")) ? { angle: number("angle") } : {}),
            ...(Number.isFinite(number("strength")) ? { strength: number("strength") } : {}),
          },
        }
      : {}),
  };
  return [{ id, appearance }];
});
/** The hex value of a declaration in an emitted style; fails when it is missing. */
const read = (style: string | undefined, property: string): HexColor => {
  const value = style?.match(new RegExp(`${property}:([^;]+)`))?.[1];
  if (!isHex(value)) throw new Error(`Missing ${property} in ${style}`);
  return value;
};
const iconStyle = (style: string | undefined) => ({ light: read(style, "--app-bar-icon-light"), dark: read(style, "--app-bar-icon-dark") });

const apps: RuntimeAppMeta[] = [
  { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/", "/help"] },
  ...["spaces", "timetrack"].map((id) => ({ id, name: id, icon: "ti ti-apps", description: id, routes: [`/app/${id}`] })),
];

test("accent scopes emit the six computed app color properties", () => {
  expect(appAccentStyle("#14b8a6")).toBe(
    "--app-accent:#14b8a6;--app-ink-light:#0d7b6f;--app-ink-dark:#14b8a6;--app-selected-light:#effaf9;--app-selected-dark:#112c2e;--app-selected-nav-light:#e8f8f6;--app-selected-nav-dark:#123133",
  );
});

test("appearance helpers reject invalid accents before emitting any CSS", () => {
  for (const accent of [undefined, "red", "#fff", "#12345g", "#123456;color:red"]) {
    expect(appAccentStyle(accent)).toBeUndefined();
    // @ts-expect-error Exercise unvalidated runtime input at the CSS emission boundary.
    expect(appAppearanceStyle(accent === undefined ? undefined : { accent })).toBeUndefined();
  }
});

test("only Core's exact full-page Help routes belong to the app named in the URL", () => {
  for (const id of ["spaces", "timetrack"]) {
    expect(resolveCurrentApp(apps, `/help/apps/${id}`)?.id).toBe(id);
    expect(resolveCurrentApp(apps, `/help/apps/${id}/start/`)?.id).toBe(id);
  }
  for (const path of ["/help", "/help/apps", "/help/apps/spaces/a/b", "/helpx/apps/spaces", "/help/apps/missing"])
    expect(resolveCurrentApp(apps, path)?.id).toBe("core");
  expect(resolveCurrentApp(apps, "/app/timetrack")?.id).toBe("timetrack");
  expect(resolveCurrentApp(apps, "/app/spaces/help/start")?.id).toBe("spaces");
});

test("built-in appearances are read from every app that declares one, Notebooks' yellow among them", () => {
  expect(builtInAppearances.length).toBeGreaterThan(5);
  expect(builtInAppearances.find(({ id }) => id === "notebooks")?.appearance).toEqual({
    accent: "#eab308",
    background: { from: "#ffd60a", to: "#ffcc00", angle: 145, strength: 24 },
  });
});

test("app bar icons keep 3:1 on every ground of the bar, for every built-in app on every built-in canvas and a yellow", () => {
  const yellow: AppAppearance = { accent: "#ffff00", background: { from: "#ffff00", strength: 40 } };
  const canvases: (AppAppearance | undefined)[] = [undefined, yellow, ...builtInAppearances.map(({ appearance }) => appearance)];
  // Third-party apps without a color take their palette tone, as in the app grid.
  const tones: HexColor[] = [
    ...builtInAppearances.map(({ appearance }) => appearance.accent),
    "#ffff00",
    "#ffffff",
    "#000000",
    ...["a", "b", "c", "d", "e", "f", "g"].map((id) => appIconTone({ id })),
  ];
  for (const canvas of canvases) {
    const grounds = appBarGrounds(canvas);
    for (const tone of tones) {
      const icon = iconStyle(appBarIconStyle(tone, grounds));
      for (const theme of ["light", "dark"] as const) {
        expect(icon[theme]).toMatch(/^#[\da-f]{6}$/);
        for (const ground of grounds[theme])
          expect(contrastRatio(icon[theme], ground), `${tone} on ${canvas?.accent ?? "neutral"} ${theme} ${ground}`).toBeGreaterThanOrEqual(
            3,
          );
      }
    }
  }
});

test("Notebooks' yellow, 1.3:1 raw on its own canvas, darkens to the mildest passing tone; a passing color stays as declared", () => {
  const notebooks = builtInAppearances.find(({ id }) => id === "notebooks")!.appearance;
  const grounds = appBarGrounds(notebooks);
  const raw = Math.min(...grounds.light.map((ground) => contrastRatio("#eab308", ground)));
  expect(raw).toBeLessThan(1.6);
  const { light } = iconStyle(appBarIconStyle("#eab308", grounds));
  expect(light).not.toBe("#eab308");
  let step = 100;
  while (step >= 0 && mixHex("#eab308", "#000000", step / 100) !== light) step--;
  expect(step).toBeLessThan(100);
  // One step milder fails somewhere: the derivation darkens no further than it must.
  expect(grounds.light.some((ground) => contrastRatio(mixHex("#eab308", "#000000", (step + 1) / 100), ground) < 3)).toBe(true);
  expect(iconStyle(appBarIconStyle("#4f46e5", appBarGrounds(notebooks))).light).toBe("#4f46e5");
});

test("app bar grounds follow the canvas global.css paints: its three stops, the tablet bar's, and the hovers over each", () => {
  const notebooks = builtInAppearances.find(({ id }) => id === "notebooks")!.appearance;
  const { light, dark } = appBarGrounds(notebooks);
  // Light: from, the white middle, and to at the declared strength over zinc-50.
  expect(light.slice(0, 3)).toEqual([
    mixHex("#ffd60a", "#fafafa", 0.24),
    mixHex("#ffffff", "#fafafa", 0.24),
    mixHex("#ffcc00", "#fafafa", 0.24),
  ]);
  // Dark: half the strength over the dark canvas, which is also the middle.
  expect(dark.slice(0, 3)).toEqual([mixHex("#ffd60a", "#090d12", 0.12), "#090d12", mixHex("#ffcc00", "#090d12", 0.12)]);
  expect(light).toHaveLength(15);
  // A page without an app color has the neutral canvas and the tablet bar's neutral tint.
  expect(appBarGrounds(undefined).light[0]).toBe("#fafafa");
  // The shares mirror global.css; changing one there must change appBarGrounds too.
  for (const declaration of [
    "--cloud-shell-strength: 34%",
    "--cloud-shell-via-strength: 16%",
    "--cloud-shell-strength: 22%",
    "--cloud-shell-via-strength: 12%",
    "var(--app-canvas-from, var(--color-zinc-400)) 45%, var(--app-canvas-to, var(--color-zinc-400))",
    "background: color-mix(in srgb, var(--k2b-surface) 45%, transparent)",
    "background: var(--k2b-app-workspace-hover)",
  ])
    expect(globalCss).toContain(declaration);
});

test("app bar icon colors reject an invalid tone before emitting any CSS", () => {
  for (const tone of [undefined, "red", "#fff", "#123456;color:red"])
    expect(appBarIconStyle(tone, appBarGrounds(undefined))).toBeUndefined();
});

test("the app bar editor's tiles show the same app color at 3:1 on their tile", () => {
  for (const accent of [...builtInAppearances.map(({ appearance }) => appearance.accent), "#ffff00", undefined]) {
    const style = appTileStyle({ id: "notes", accent });
    const tone = read(style, "--app-icon-color");
    for (const [theme, surface] of [
      ["light", "#ffffff"],
      ["dark", "#11151b"],
    ] as const) {
      const glyph = read(style, `--app-tile-ink-${theme}`);
      expect(contrastRatio(glyph, mixHex(tone, surface, 0.12)), `${accent} ${theme}`).toBeGreaterThanOrEqual(3);
    }
  }
});
