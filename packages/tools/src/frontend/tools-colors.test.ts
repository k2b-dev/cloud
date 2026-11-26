import { expect, test } from "bun:test";
import { methodColors, toolColors } from "./tools-colors";

// The surfaces v2 draws a data colour on (`--k2-surface` in light and dark, packages/ui/src/v2/v2.css).
const SURFACES = { light: "#ffffff", dark: "#11151b" };

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

test("every Tools data colour keeps 3:1 on the light and the dark surface", () => {
  const colors = {
    ...toolColors,
    ...Object.fromEntries(Object.entries(methodColors).map(([method, color]) => [`method ${method}`, color])),
  };
  const weak = Object.entries(colors).flatMap(([name, color]) =>
    Object.entries(SURFACES)
      .map(([surface, background]) => ({ name, surface, ratio: Math.round(contrast(color, background) * 100) / 100 }))
      .filter((entry) => entry.ratio < 3),
  );
  expect(weak).toEqual([]);
});
