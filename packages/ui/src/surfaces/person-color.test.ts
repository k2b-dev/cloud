import { describe, expect, test } from "bun:test";
import { PERSON_COLORS, personColor, personTint } from "./person-color";

// OKLCH hue of an sRGB hex color (Björn Ottosson's OKLab), in degrees.
const hue = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
};
const distance = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));

describe("person colors", () => {
  test("stay away from the AI cyan and from highlight yellow", () => {
    // `--k2b-ai-accent` in light and dark, and the yellow of a Markdown highlight and the Notebooks accent.
    const reserved = ["#0891b2", "#22d3ee", "#eab308", "#facc15"].map(hue);
    for (const color of PERSON_COLORS) {
      for (const taken of reserved) expect(distance(hue(color), taken), color).toBeGreaterThan(20);
    }
  });

  test("give one name one color, ignoring surrounding spaces", () => {
    expect(personColor(" Nora Brandt ")).toBe(personColor("Nora Brandt"));
    expect(personColor("Nora Brandt")).toBe(PERSON_COLORS[personTint("Nora Brandt")]!);
    expect(new Set(["Ada", "Ben", "Cleo", "Dan", "Eve", "Finn", "Gus", "Hanna"].map(personColor)).size).toBeGreaterThan(3);
  });
});
