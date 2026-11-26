import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { colorStyle, contrast, safeColor } from "./colors";

// Data colours reach a style only when they are colours, and their foregrounds stay readable whatever the colour is.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-colors-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Avatar, Chip, Mark, custom } = await import("./marks");
const { Tiles, Cells } = await import("./layout");
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
