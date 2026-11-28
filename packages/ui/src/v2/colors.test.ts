import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { accentStyle, pageAccent } from "./accent";
import { appTint, colorStyle, contrast, safeColor, selectedTint } from "./colors";

// Data colours reach a style only when they are colours, and their foregrounds stay readable whatever the colour is.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-colors-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Avatar, Chip, Mark, custom } = await import("./marks");
const { Tiles, Cells, Workspace, Pane } = await import("./layout");
const { Digest, Nav } = await import("./components");
const { Section } = await import("./structure");

const html = <P extends object>(component: (props: P) => JSX.Element, props: P) => renderToString(() => createComponent(component, props));

const notColours = [
  "#008f4c;position:fixed;inset:0;width:100vw;height:100vh;z-index:999999",
  "#008f4c; background: url(https://example.invalid/x.png)",
  "red;",
  "var(--k2-app);display:none",
  "url(https://example.invalid/x.png)",
  "expression(alert(1))",
  "#gggggg",
  "oklch(0.6 0.1 30);color:red",
  "</style><script>",
  "inherit",
  "",
];

describe("a data colour", () => {
  test("is accepted as hex, oklch() of plain numbers, or a custom property of the page", () => {
    for (const colour of ["#08f", "#08fc", "#008f4c", "#008f4ccc", "oklch(0.62 0.17 145)", "oklch(62% 0.17 145deg / 0.8)", "var(--k2-app)"])
      expect(safeColor(colour)).toBe(colour);
  });

  test("anything else is dropped, so no declaration of its own reaches the style", () => {
    for (const value of notColours) {
      expect(safeColor(value)).toBeUndefined();
      expect(custom({ "--k2-c": value })).toBeUndefined();
    }
  });

  test("the primitive's own values cannot end their declaration either", () => {
    expect(custom({ "--k2-p": "38%" })).toEqual({ "--k2-p": "38%" });
    expect(custom({ "--k2-p": "38%;position:fixed" })).toBeUndefined();
  });

  test("every primitive that takes a colour renders neutral with a value that is no colour", () => {
    const evil = notColours[0]!;
    const markups = [
      html(Mark, { icon: "table", color: evil }),
      html(Avatar, { name: "Jana Berger", color: evil }),
      html(Avatar.Stack, { people: [{ name: "Jana Berger", color: evil }] }),
      html(Chip, { tag: true, color: evil, children: "Kunde" }),
      html(Nav, { title: "Grids", icon: "table", groups: [{ items: [{ label: "Werkstatt", icon: "tool", color: evil }] }] }),
      html(Tiles, { items: [{ icon: "tool", title: "Werkstatt", color: evil }] }),
      html(Tiles, { variant: "card", items: [{ icon: "tool", title: "Werkstatt", color: evil, trend: { values: [1, 2], label: "x" } }] }),
      html(Section, { title: "Anstehend", icon: "checklist", color: evil }),
      html(Cells.Cell, { icon: "package", label: "Einlieferungen", value: "2", color: evil }),
      html(Digest, {
        items: [{ icon: "package", color: evil, date: "3. Nov.", title: "EL-1", state: { icon: "check", label: "Läuft" }, text: "x" }],
      }),
    ];
    for (const markup of markups) {
      expect(markup).not.toContain("position");
      expect(markup).not.toContain("z-index");
      expect(markup).not.toContain("--k2-c:");
    }
  });
});

describe("the foregrounds of a data colour", () => {
  const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as [number, number, number];
  const mix = (a: [number, number, number], share: number, b: [number, number, number]) =>
    a.map((channel, index) => channel * share + b[index]! * (1 - share)) as unknown as [number, number, number];
  const white: [number, number, number] = [255, 255, 255];
  const dark: [number, number, number] = [17, 21, 27];
  // the colours of the recipes, a pale yellow, a bright green, and the ends
  const colours = [
    "#008f4c",
    "#c2410c",
    "#2563eb",
    "#0f766e",
    "#7c3aed",
    "#15803d",
    "#db2777",
    "#475569",
    "#fef08a",
    "#22c55e",
    "#f59e0b",
    "#ffffff",
    "#000000",
  ];

  test("a symbol keeps 3:1 on its tint, light and dark", () => {
    for (const colour of colours) {
      const style = colorStyle(colour)!;
      expect(contrast(rgb(style["--k2-c-fg"]!), mix(rgb(colour), 0.13, white))).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb(style["--k2-c-fg-dark"]!), mix(rgb(colour), 0.13, dark))).toBeGreaterThanOrEqual(3);
    }
  });

  test("the bars of a history keep 3:1 on the surface, the strong one 4.5:1, and they differ", () => {
    for (const colour of colours) {
      const style = colorStyle(colour)!;
      expect(contrast(rgb(style["--k2-c-soft"]!), white)).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb(style["--k2-c-ink"]!), white)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(style["--k2-c-soft-dark"]!), dark)).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb(style["--k2-c-ink-dark"]!), dark)).toBeGreaterThanOrEqual(4.5);
    }
    for (const colour of ["#008f4c", "#c2410c", "#2563eb", "#fef08a"]) {
      const style = colorStyle(colour)!;
      expect(style["--k2-c-soft"]).not.toBe(style["--k2-c-ink"]);
    }
  });

  test("white type on the ink of a colour keeps 4.5:1 (the type on a mark)", () => {
    for (const colour of colours) expect(contrast(white, rgb(colorStyle(colour)!["--k2-c-ink"]!))).toBeGreaterThanOrEqual(4.5);
  });

  test("a colour the stylesheet cannot work out (oklch, a custom property) brings no foregrounds; the stylesheet's mix stands", () => {
    expect(colorStyle("oklch(0.62 0.17 145)")).toEqual({ "--k2-c": "oklch(0.62 0.17 145)" });
    expect(colorStyle("var(--k2-app)")).toEqual({ "--k2-c": "var(--k2-app)" });
  });
});

// A colour for each theme: `light-dark()` of two colours keeps a data colour at its contrast in light and in dark. Both
// sides are colours of the accepted forms themselves; nothing else gets through the pair.
test("light-dark() of two colours is a colour, each side checked", () => {
  expect(safeColor("light-dark(#1d4ed8, #93c5fd)")).toBe("light-dark(#1d4ed8, #93c5fd)");
  expect(safeColor(" light-dark( #b45309 ,var(--k2-amber) ) ")).toBe("light-dark(#b45309, var(--k2-amber))");
  expect(safeColor("light-dark(oklch(0.62 0.19 264), #fff)")).toBe("light-dark(oklch(0.62 0.19 264), #fff)");
  for (const color of [
    "light-dark(#1d4ed8)",
    "light-dark(#1d4ed8, #93c5fd, #000)",
    "light-dark(#1d4ed8, red)",
    "light-dark(#1d4ed8, url(https://example.org/x.png))",
    "light-dark(#1d4ed8, #93c5fd);background:url(https://example.org/x.png)",
    "light-dark(light-dark(#000, #fff), #fff)",
    "light-dark(#1d4ed8), url(x), light-dark(#93c5fd)",
    "light-dark(#1d4ed8, #93c5fd))",
  ])
    expect(safeColor(color)).toBeUndefined();
});

// A page's own accent (`Workspace accent`): a colour from data, whose readable tones are worked out where it arrives.
describe("a page's accent", () => {
  type Rgb = [number, number, number];
  const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as Rgb;
  const mix = (a: Rgb, share: number, b: Rgb) => a.map((channel, index) => channel * share + b[index]! * (1 - share)) as Rgb;
  const white: Rgb = [255, 255, 255];
  const dark: Rgb = [17, 21, 27];
  const nearBlack = "#09090b";
  // yellow, light grey, navy, pure red, the warm orange and green of the guest pages, and a middle grey on which
  // neither white nor near-black keeps 4.5:1
  const choices: [colour: string, ink: string, keepsFill: boolean][] = [
    ["#facc15", nearBlack, true],
    ["#d4d4d8", nearBlack, true],
    ["#1e3a8a", "#ffffff", true],
    ["#ff0000", nearBlack, true],
    ["#c2410c", "#ffffff", true],
    ["#15803d", "#ffffff", true],
    ["#777777", "#ffffff", false],
  ];

  test("the primary's words are white or near-black by contrast, and a fill on which neither reads is darkened", () => {
    for (const [colour, ink, keepsFill] of choices) {
      const style = accentStyle(colour)!;
      expect(style["--k2-app"]).toBe(colour);
      expect(style["--k2-primary-ink"]).toBe(ink);
      if (keepsFill) expect(style["--k2-primary"]).toBe(colour);
      expect(contrast(rgb(style["--k2-primary"]!), rgb(ink))).toBeGreaterThanOrEqual(4.5);
    }
    // the middle grey: white fails by a little (4.48:1), so the fill steps towards black only until white reads
    const grey = accentStyle("#777777")!;
    expect(contrast(white, rgb("#777777"))).toBeLessThan(4.5);
    expect(contrast(rgb(nearBlack), rgb("#777777"))).toBeLessThan(4.5);
    expect(grey["--k2-primary"]).not.toBe("#777777");
    expect(contrast(white, rgb(grey["--k2-primary"]!))).toBeLessThan(4.7);
  });

  test("as text the colour keeps 4.5:1 on the surface and on its tint, light and dark; a bar's quiet tone keeps 3:1", () => {
    for (const [colour] of choices) {
      const style = accentStyle(colour)!;
      const own = rgb(colour);
      const inkLight = rgb(style["--k2-accent-ink-light"]!);
      const inkDark = rgb(style["--k2-accent-ink-dark"]!);
      expect(contrast(inkLight, white)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inkLight, mix(own, appTint.light, white))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inkDark, dark)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inkDark, mix(own, appTint.dark, dark))).toBeGreaterThanOrEqual(4.5);
      // a quiet bar keeps 3:1 on every ground it stands on: the surface, the app's tint and a chosen row's blue tint
      const softLight = rgb(style["--k2-accent-soft-light"]!);
      const softDark = rgb(style["--k2-accent-soft-dark"]!);
      for (const ground of [white, mix(own, appTint.light, white), selectedTint.light])
        expect(contrast(softLight, ground)).toBeGreaterThanOrEqual(3);
      for (const ground of [dark, mix(own, appTint.dark, dark), selectedTint.dark])
        expect(contrast(softDark, ground)).toBeGreaterThanOrEqual(3);
      // the quiet bars stay apart from the strongest one
      expect(style["--k2-accent-soft-light"]).not.toBe(style["--k2-accent-ink-light"]);
    }
    // a colour that reads already stays as it is; yellow darkens in light, navy lightens in dark, both in their hue
    expect(accentStyle("#1e3a8a")!["--k2-accent-ink-light"]).toBe("#1e3a8a");
    const yellow = accentStyle("#facc15")!;
    expect(yellow["--k2-accent-ink-dark"]).toBe("#facc15");
    const [r, g, b] = rgb(yellow["--k2-accent-ink-light"]!);
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
    const navy = rgb(accentStyle("#1e3a8a")!["--k2-accent-ink-dark"]!);
    expect(navy[2]).toBeGreaterThan(navy[0]);
  });

  test("a value that is no opaque hex colour gives nothing, so the app's colour stands", () => {
    for (const value of [
      ...notColours,
      undefined,
      "red",
      "#c2410c80",
      "#c41c",
      "oklch(0.62 0.17 145)",
      "var(--k2-app)",
      "light-dark(#000, #fff)",
    ])
      expect(accentStyle(value)).toBeUndefined();
    expect(accentStyle("#C2410C")!["--k2-app"]).toBe("#c2410c");
    expect(accentStyle("#fc0")!["--k2-app"]).toBe("#ffcc00");
  });

  test("a primary that would vanish on the surface gets an edge of its own colour at 3:1, per theme", () => {
    const pale = accentStyle("#fff3a0")!;
    expect(contrast(rgb("#fff3a0"), white)).toBeLessThan(3);
    expect(pale["--k2-accent-edge-light"]).not.toBe("#fff3a0");
    expect(contrast(rgb(pale["--k2-accent-edge-light"]!), white)).toBeGreaterThanOrEqual(3);
    // on the dark surface the pale fill shows by itself, and navy needs a lighter edge there
    expect(pale["--k2-accent-edge-dark"]).toBe("#fff3a0");
    const navy = accentStyle("#1e3a8a")!;
    expect(navy["--k2-accent-edge-light"]).toBe("#1e3a8a");
    expect(contrast(rgb(navy["--k2-accent-edge-dark"]!), dark)).toBeGreaterThanOrEqual(3);
    for (const [colour] of choices) {
      const style = accentStyle(colour)!;
      expect(contrast(rgb(style["--k2-accent-edge-light"]!), white)).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb(style["--k2-accent-edge-dark"]!), dark)).toBeGreaterThanOrEqual(3);
    }
  });

  test("the tints the tones are checked against are the ones the stylesheet paints", () => {
    const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
    const hexOf = (channels: readonly number[]) => `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    expect(css).toContain(`--k2-blue-tint: ${hexOf(selectedTint.light)};`);
    expect(css).toContain(`--k2-blue-tint: ${hexOf(selectedTint.dark)};`);
    expect(css).toContain(`--k2-app-tint-mix: color-mix(in srgb, var(--k2-app) ${Math.round(appTint.light * 100)}%, var(--k2-surface));`);
    expect(css).toContain(`--k2-app-tint-mix: color-mix(in srgb, var(--k2-app) ${Math.round(appTint.dark * 100)}%, var(--k2-surface));`);
  });

  test("the server sends the workspace with its accent, so the first paint is final; a value that is no colour sends none", () => {
    const page = (accent: string) =>
      html(Workspace, { accent: pageAccent(accent), children: createComponent(Pane, { label: "Seite", children: "" }) });
    const markup = page("#c2410c");
    expect(markup).toContain("data-k2-accent");
    expect(markup).toContain("--k2-app:#c2410c");
    expect(markup).toContain("--k2-primary-ink:#ffffff");
    for (const value of [notColours[0]!, "oklch(0.62 0.17 145)"]) {
      const plain = page(value);
      expect(plain).not.toContain("data-k2-accent");
      expect(plain).not.toContain("--k2-app:");
      expect(plain).not.toContain("position");
    }
  });
});
