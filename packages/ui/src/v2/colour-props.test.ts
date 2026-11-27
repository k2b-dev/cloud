import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { safeColor, safeValue } from "./colors";

// A colour prop takes a colour and nothing else: what it carries goes into the style attribute the server sends, and a
// value from data must never add declarations of its own. The same function runs on the server and in the browser.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-colour-props-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Avatar, Chip, custom } = await import("./marks");
const { Row } = await import("./content");
const { Cells } = await import("./layout");
const { Section } = await import("./structure");

const unsafe = [
  "red;position:fixed;inset:0;background:url(https://example.org/x.png)",
  "#7c3aed;color:transparent",
  "var(--x);display:none",
  "#7c3aed}body{display:none",
  "url(https://example.org/x.png)",
  "expression(alert(1))",
  "<b>",
];

test("a colour is a hex colour, an oklch() of plain numbers or a custom property of the page", () => {
  for (const color of [
    "#7c3aed",
    "#fff",
    "#7c3aed80",
    " #0d9488 ",
    "oklch(0.62 0.19 264)",
    "oklch(62% 0.19 264deg / 50%)",
    "var(--k2-blue)",
  ])
    expect(safeColor(color)).toBe(color.trim());
  for (const color of [...unsafe, "red", "rgb(1, 2, 3)", "var(--a) var(--b)", "oklch(calc(1) 0 0)", ""])
    expect(safeColor(color)).toBeUndefined();
  expect(safeValue("140px")).toBe(true);
  expect(safeValue("1px;color:red")).toBe(false);
});

test("custom() drops a colour that is no colour and a value that would end its declaration", () => {
  expect(custom({ "--k2-c": "#7c3aed", "--k2-p": "42%" })).toEqual({ "--k2-c": "#7c3aed", "--k2-p": "42%" });
  for (const value of unsafe) expect(custom({ "--k2-c": value })).toBeUndefined();
  expect(custom({ "--k2-p": "1%;position:fixed" })).toBeUndefined();
});

const parts: [string, (color: string) => JSX.Element][] = [
  ["Avatar", (color) => createComponent(Avatar, { name: "Ada Renz", color })],
  ["Chip", (color) => createComponent(Chip, { tag: true, color, children: "Lager" })],
  ["Row", (color) => createComponent(Row, { lines: ["Lager"], icon: "box", color })],
  ["Cells.Cell", (color) => createComponent(Cells.Cell, { icon: "box", label: "Lager", value: "12", color })],
  ["Section", (color) => createComponent(Section, { title: "Lager", icon: "box", color, children: "" })],
];

for (const [name, draw] of parts)
  test(`${name} sends a colour from data into its style, and nothing that is no colour`, () => {
    expect(renderToString(() => draw("#7c3aed"))).toContain("--k2-c:#7c3aed");
    for (const value of unsafe) {
      const markup = renderToString(() => draw(value));
      expect(markup).not.toMatch(/position:\s*fixed|display:\s*none|url\(|expression|color:\s*transparent|<b>/);
    }
  });
