import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appIds } from "../../../../scripts/workspace";
import { SHELL_DARK_SELECTED_TINT, SHELL_SURFACE, shellInk } from "../ssr/app-appearance";

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");
const shell = read("global.css");
const tokens = read("tokens.css");
const ui = read("../../../ui/src/styles/index.css");
type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected a six-digit sRGB color: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
};
const mix = (a: RGB, weight: number, b: RGB): RGB => [
  a[0] * weight + b[0] * (1 - weight),
  a[1] * weight + b[1] * (1 - weight),
  a[2] * weight + b[2] * (1 - weight),
];
const luminance = (color: RGB) =>
  color
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: RGB, b: RGB) => {
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
};
const declarations = (css: string, name: string) =>
  [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((match) => match[1]!.trim());
const token = (css: string, name: string, dark: boolean): string => {
  const values = declarations(css, name);
  const value = values[dark && values.length > 1 ? 1 : 0];
  if (!value) throw new Error(`Missing ${name}`);
  const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return variable && declarations(css, variable).length ? token(css, variable, dark) : value;
};
const percent = (name: string, dark: boolean) => parseFloat(token(shell, name, dark)) / 100;
// Percentages inside color-mix() are read from the owning rules, rather than
// copying the current 45% into a second palette.
const selectedBackground = declarations(shell, "--cloud-shell-selected");
const weight = (value: string) => {
  const match = value.match(/\)\s*(\d+)%/);
  if (!match) throw new Error(`Cannot read color-mix weight: ${value}`);
  return Number(match[1]) / 100;
};
const middleWeight = weight(
  shell.match(/color-mix\(in srgb, var\(--app-canvas-from, var\(--color-zinc-400\)\) \d+%, var\(--app-canvas-to[^\n]+/)?.[0] ?? "",
);

// Follow the workspace app set, including newly added apps. Reading declarations
// avoids starting each application's database/services just to inspect its colors.
const appearances = appIds().flatMap((id) => {
  const path = resolve(import.meta.dir, `../../../${id}/src/config.ts`);
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const appearance = source.match(/\bappearance:\s*\{([\s\S]*?)\}\s*[,}]/)?.[1];
  if (source.includes("appearance:") && !appearance) throw new Error(`Cannot parse ${id} appearance`);
  if (!appearance) return []; // Gateway and the phone app declare no appearance.
  const color = (key: string) => {
    const match = appearance?.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`));
    if (appearance?.includes(`${key}:`) && !match) throw new Error(`Cannot parse ${id}.${key}`);
    if (match) rgb(match[1]!); // Fail closed if a new declaration needs a different parser.
    return match?.[1];
  };
  const accent = color("accent");
  if (!accent) throw new Error(`${id} appearance needs an accent`);
  const from = color("from") ?? accent;
  const to = color("to") ?? from;
  return [{ id, accent, from, to }];
});

describe("built-in shell gradient contrast", () => {
  for (const appearance of appearances) {
    for (const dark of [false, true]) {
      test(`${appearance.id} ${dark ? "dark" : "light"}: labels, titles, icons and selected item meet WCAG`, () => {
        // The light canvas uses Tailwind zinc-50 (oklch in Tailwind's source);
        // its sRGB canvas is #fafafa. Other colors come from hex declarations.
        const canvasToken = token(tokens, "--ui-canvas", dark);
        const canvas = rgb(canvasToken === "var(--color-zinc-50)" ? "#fafafa" : canvasToken);
        const from = rgb(appearance.from);
        const to = rgb(appearance.to);
        const accent = rgb(appearance.accent);
        const stops = [
          mix(from, percent("--cloud-shell-strength", dark), canvas),
          mix(mix(from, middleWeight, to), percent("--cloud-shell-via-strength", dark), canvas),
          mix(to, percent("--cloud-shell-strength", dark), canvas),
        ];
        const secondary = rgb(token(ui, "--k2b-text-secondary", dark));
        const text = rgb(token(ui, "--k2b-text", dark));
        const surface = rgb(token(ui, "--k2b-surface", dark));
        // The server computes the open item's text color from the same surface and tint as the stylesheet.
        expect<string>(SHELL_SURFACE[dark ? "dark" : "light"]).toBe(token(ui, "--k2b-surface", dark));
        if (dark) expect(SHELL_DARK_SELECTED_TINT).toBe(weight(selectedBackground[1]!));
        const selected = dark ? mix(accent, weight(selectedBackground[1]!), surface) : surface;
        const selectedText = rgb(shellInk(appearance.accent)[dark ? "dark" : "light"]);
        const ratios = stops.flatMap((stop, index) => [
          { kind: `bar label at stop ${index}`, ratio: contrast(secondary, stop), minimum: 4.5 },
          { kind: `header title at stop ${index}`, ratio: contrast(text, stop), minimum: 4.5 },
          { kind: `rail icon at stop ${index}`, ratio: contrast(secondary, stop), minimum: 3 },
        ]);
        ratios.push({ kind: "selected item", ratio: contrast(selectedText, selected), minimum: 4.5 });
        expect(
          ratios.filter(({ ratio, minimum }) => !Number.isFinite(ratio) || ratio < minimum),
          `${appearance.id} ${dark ? "dark" : "light"}`,
        ).toEqual([]);
      });
    }
  }
});
