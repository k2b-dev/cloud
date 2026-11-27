import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { cssColor } from "./color";

// A colour prop takes a colour and nothing else: the server writes it into a style attribute, and a value from data
// must never add a declaration of its own there. The same check runs in the browser. (FloatingWindow draws only in the
// browser, where a value that is no colour is dropped by the same check; it has no server markup to test here.)
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-colour-values-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Chat, ColorChoices, DashboardSection, DetailPresence, NoticeRow } = await import("../index");
const { Select } = await import("../inputs/Select");
const { Avatar } = await import("../surfaces/Avatar");
const { ReferenceChip } = await import("../content/ReferenceChip");
const { default: Navigation } = await import("../layout/Navigation");
const { createNavigation } = await import("../layout/navigation-model");
const { default: AppWorkspace } = await import("../layout/AppWorkspace");
const { default: Calendar } = await import("../content/Calendar");

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
    // the tint of a section symbol in the code page tree (core), mixed in CSS
    "color-mix(in srgb, var(--color-blue-600) 78%, var(--k2b-text))",
    "light-dark(#ffffff, #000000)",
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
  for (const color of [...unsafe, "expression(alert(1))", "color-mix(in srgb, url(x) 5%, red)", "(1)", "rgb(1, 2, 3", "", undefined])
    expect(cssColor(color)).toBeUndefined();
});

test("the check stays linear in time on a long input", () => {
  for (const long of ["a".repeat(100_000) + "()", "a".repeat(100_000) + "(", "rgb(".repeat(25_000), "#".repeat(100_000)]) {
    const start = performance.now();
    expect(cssColor(long)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(50);
  }
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
    "DashboardSection (color-mix)",
    (color) =>
      createComponent(DashboardSection, {
        title: "Seiten",
        icon: "ti ti-file",
        iconColor: `color-mix(in srgb, ${color} 78%, var(--k2b-text))`,
        children: "",
      }),
  ],
  ["Avatar ring", (color) => createComponent(Avatar, { name: "Ada Renz", ring: { color } })],
  [
    "ReferenceChip",
    (color) => createComponent(ReferenceChip, { kind: "object", title: "Wartungsfenster", icon: "ti ti-mail", accent: color, href: "/m" }),
  ],
  ["Select", (color) => createComponent(Select, { label: "Status", value: "a", options: [{ value: "a", label: "Offen", color }] })],
  [
    "Navigation",
    (color) =>
      createComponent(Navigation, {
        label: "Spaces",
        navigation: createNavigation({ items: () => [{ id: "a", label: "Lager", href: "/a", color }] }),
      }),
  ],
  [
    "SidebarSwitcher",
    (color) =>
      createComponent(AppWorkspace.SidebarSwitcher, {
        currentId: "a",
        label: "Lager",
        icon: "ti-box",
        color,
        switchLabel: "Bereich wechseln",
        options: [{ id: "a", label: "Lager", href: "#a", color }],
      }),
  ],
  ...(["week", "month"] as const).map((view): [string, (color: string) => JSX.Element] => [
    `Calendar ${view}`,
    (color) =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        view,
        timeZone: "UTC",
        events: [{ id: "r", title: "Review", start: "2026-07-15T09:00:00Z", end: "2026-07-15T10:00:00Z", colorHex: color }],
      }),
  ]),
  ["Chat.Activity", (color) => createComponent(Chat.Activity, { icon: "ti ti-sparkles", accent: color, label: "Gustav denkt nach" })],
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
