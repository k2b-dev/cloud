import { describe, expect, test } from "bun:test";
import {
  PERSON_COLORS,
  PERSON_COLORS_DARK,
  personColor,
  personColorDark,
  personMarkColor,
  personMarkColorOf,
  personTint,
} from "./person-color";

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

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: readonly number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `color-mix(in srgb, a p, b)` */
const mix = (a: string, b: string, p: number) => channels(a).map((x, i) => Math.round(x * p + channels(b)[i]! * (1 - p)));

/** CIELAB (D65) of linear sRGB. */
const lab = ([r, g, b]: readonly number[]): [number, number, number] => {
  const x = (0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047;
  const y = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const z = (0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const rad = (deg: number) => (deg * Math.PI) / 180;
/** CIEDE2000 colour difference. */
const de2000 = ([l1, a1, b1]: readonly number[], [l2, a2, b2]: readonly number[]) => {
  const cb = (Math.hypot(a1!, b1!) + Math.hypot(a2!, b2!)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cb ** 7 / (cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + g) * a1!, (1 + g) * a2!];
  const [c1, c2] = [Math.hypot(a1p, b1!), Math.hypot(a2p, b2!)];
  const [h1, h2] = [((Math.atan2(b1!, a1p) * 180) / Math.PI + 360) % 360, ((Math.atan2(b2!, a2p) * 180) / Math.PI + 360) % 360];
  let dh = h2 - h1;
  if (c1 * c2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
  const [lb, cbp] = [(l1! + l2!) / 2, (c1 + c2) / 2];
  const hb = c1 * c2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  const t =
    1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb)) + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
  const rc = 2 * Math.sqrt(cbp ** 7 / (cbp ** 7 + 25 ** 7));
  const rt = -Math.sin(rad(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)))) * rc;
  const [sl, sc, sh] = [1 + (0.015 * (lb - 50) ** 2) / Math.sqrt(20 + (lb - 50) ** 2), 1 + 0.045 * cbp, 1 + 0.015 * cbp * t];
  const [dl, dc] = [l2! - l1!, c2 - c1];
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
};
/** Colour vision deficiency at full severity (Machado, Oliveira and Fernandes 2009), on linear sRGB. */
const visions: Record<string, number[][] | null> = {
  normal: null,
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const seen = (hex: string, matrix: number[][] | null) => {
  const rgb = channels(hex).map(linear);
  return lab(matrix ? matrix.map((row) => Math.min(1, Math.max(0, row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!))) : rgb);
};

describe("person colors", () => {
  test("stay away from the AI plum and from highlight yellow", () => {
    // `--k2b-ai-accent` in light and dark, and the yellow of a Markdown highlight and the Notebooks accent.
    const reserved = ["#8e1b6f", "#f0abdc", "#eab308", "#facc15"].map(hue);
    for (const color of PERSON_COLORS) {
      for (const taken of reserved) expect(distance(hue(color), taken), color).toBeGreaterThan(20);
    }
  });

  test("keep white initials (v2) and the mixed initials of v1 readable, at least 4.5:1, light and dark", () => {
    for (const color of PERSON_COLORS) {
      expect([color, contrast(channels(color), [255, 255, 255]) >= 4.5]).toEqual([color, true]);
      // v1: the hue 55 % into the text on the hue 18 % into the surface (surfaces-widgets-parity.css)
      for (const [text, surface] of [
        ["#09090b", "#ffffff"],
        ["#fafafa", "#11151b"],
      ] as const)
        expect([color, surface, contrast(mix(color, text, 0.55), mix(color, surface, 0.18)) >= 4.5]).toEqual([color, surface, true]);
    }
  });

  test("mark a page in either theme: the hue 3:1 on the light surface, its dark step 3:1 on the dark one", () => {
    expect(PERSON_COLORS_DARK).toHaveLength(PERSON_COLORS.length);
    for (const [index, color] of PERSON_COLORS.entries()) {
      // each dark step is the hue 45 % towards white, the `color-mix` a v2 face writes for it (marks.tsx)
      // (the table rounds a half, the browser mixes exactly)
      const exact = channels(color).map((channel) => channel * 0.55 + 255 * 0.45);
      const step = channels(PERSON_COLORS_DARK[index]!);
      expect([PERSON_COLORS_DARK[index], exact.every((channel, at) => Math.abs(channel - step[at]!) <= 0.5)]).toEqual([
        PERSON_COLORS_DARK[index],
        true,
      ]);
      expect([color, contrast(channels(color), [255, 255, 255]) >= 3]).toEqual([color, true]);
      const dark = PERSON_COLORS_DARK[index]!;
      expect([dark, contrast(channels(dark), channels("#11151b")) >= 3]).toEqual([dark, true]);
    }
  });

  test("keep soft initials readable on their tint, at least 4.5:1, in light and dark (v2 soft avatar, record head)", () => {
    for (const [index, color] of PERSON_COLORS.entries()) {
      // light: the hue 85 % into black on the hue 16 % into the surface (v2.css, soft initials)
      expect([color, contrast(mix(color, "#000000", 0.85), mix(color, "#ffffff", 0.16)) >= 4.5]).toEqual([color, true]);
      // dark: the dark step on itself 16 % into the dark surface
      const dark = PERSON_COLORS_DARK[index]!;
      expect([dark, contrast(channels(dark), mix(dark, "#11151b", 0.16)) >= 4.5]).toEqual([dark, true]);
    }
  });

  test("give a mark both hues, and leave a color outside the palette as it is", () => {
    expect(personMarkColor("Nora Brandt")).toBe(`light-dark(${personColor("Nora Brandt")}, ${personColorDark("Nora Brandt")})`);
    expect(personMarkColorOf(PERSON_COLORS[3].toUpperCase())).toBe(`light-dark(${PERSON_COLORS[3]}, ${PERSON_COLORS_DARK[3]})`);
    expect(personMarkColorOf("#8a8478")).toBe("#8a8478");
  });

  test("stay apart pair by pair, also for people who see colours differently (CIEDE2000 of at least 5)", () => {
    for (const [vision, matrix] of Object.entries(visions))
      for (const [index, a] of PERSON_COLORS.entries())
        for (const b of PERSON_COLORS.slice(index + 1)) {
          const difference = de2000(seen(a, matrix), seen(b, matrix));
          expect([vision, a, b, difference >= 5]).toEqual([vision, a, b, true]);
        }
  });

  test("give one name one color, ignoring surrounding spaces", () => {
    expect(personColor(" Nora Brandt ")).toBe(personColor("Nora Brandt"));
    expect(personColor("Nora Brandt")).toBe(PERSON_COLORS[personTint("Nora Brandt")]!);
    expect(new Set(["Ada", "Ben", "Cleo", "Dan", "Eve", "Finn", "Gus", "Hanna"].map(personColor)).size).toBeGreaterThan(4);
  });
});
