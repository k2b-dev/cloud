import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { cssColor } from "./color";

// A colour prop takes a colour and nothing else: the server writes it into a style attribute, and a value from data
// must never add a declaration of its own there. The same check runs in the browser.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-colour-values-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Chat, ColorChoices, DashboardSection, DetailPresence, NoticeRow } = await import("../index");

const unsafe = [
  "red;position:fixed;inset:0;background:url(https://example.org/x.png)",
  "#7c3aed;color:transparent",
  "var(--x);display:none",
  "#7c3aed}body{display:none",
  "url(https://example.org/x.png)",
  "rgb(1, 2, 3) url(https://example.org/x.png)",
  "<b>",
];
const injected = /position:\s*fixed|display:\s*none|url\(|color:\s*transparent|<b>/;

test("a colour is a hex colour, a colour name, a colour function of plain numbers or a custom property", () => {
  for (const color of [
    "#fff",
    "#0f766e",
    "#7c3aed80",
    "blue",
    "transparent",
    "var(--k2b-ai-accent)",
    "rgb(124, 58, 237)",
    "oklch(0.62 0.19 264 / 50%)",
  ])
    expect(cssColor(color)).toBe(color);
  for (const color of [...unsafe, "blue red", "var(--a, red)", "expression(alert(1))", "", undefined])
    expect(cssColor(color)).toBeUndefined();
});

const noop = () => undefined;
const parts: [string, (color: string) => JSX.Element][] = [
  ["NoticeRow", (color) => createComponent(NoticeRow, { tile: "ti ti-bell", tileColor: color, children: "Neu" })],
  ["DashboardSection", (color) => createComponent(DashboardSection, { title: "Lager", icon: "ti ti-box", iconColor: color, children: "" })],
  ["DetailPresence", (color) => createComponent(DetailPresence, { people: [{ id: "ada", name: "Ada Renz", color }] })],
  [
    "ColorChoices",
    (color) => createComponent(ColorChoices, { label: "Farbe", value: null, options: [{ value: "a", label: "Eigene", color }] }),
  ],
  [
    "Chat.Decision",
    (color) =>
      createComponent(Chat.Decision, {
        state: "open",
        kind: { label: "Freigabe", icon: "ti ti-shield-check" },
        source: { name: "Mail", icon: "ti ti-mail", accent: color },
        sentence: "Die Mail senden?",
        confirm: { label: "Senden", icon: "ti ti-send", onSelect: noop },
      }),
  ],
];

for (const [name, draw] of parts)
  test(`${name} sends a colour from data into its style, and nothing that is no colour`, () => {
    expect(renderToString(() => draw("#7c3aed"))).toContain("#7c3aed");
    for (const value of unsafe) expect(renderToString(() => draw(value))).not.toMatch(injected);
  });
