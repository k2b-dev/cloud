import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for a card's own lines (such as the pages a template makes) and for cards that share a row.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-tile-lines-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Tiles } = await import("./layout");
const { LocaleProvider } = await import("../intl/locale");

const html = <P extends object>(component: (props: P) => JSX.Element, props: P) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(component, props);
      },
    }),
  );

const handbook = {
  icon: "book",
  title: "Handbuch",
  meta: "Kapitel, Abläufe und Ansprechpersonen",
  href: "/app/notebooks?template=handbook",
  stats: [{ icon: "files", label: "5 Seiten" }],
  lines: [
    { text: "Handbuch" },
    { text: "Wareneingang" },
    { text: "Annahme prüfen", level: 1 },
    { text: "Kühlware", level: 2 },
    { text: "zu tief", level: 40 },
  ],
  linesMore: "+12 weitere Seiten",
};

test("a card's lines come from the server in reading order, indented by level, with the more line last", () => {
  const markup = html(Tiles, { variant: "card", label: "Vorlagen", items: [handbook] });
  const lines = [...markup.matchAll(/<span class="k2-tile-line"([^>]*)>([^<]*)<\/span>/g)].map(([, attributes, text]) => ({
    text,
    level: attributes!.match(/--k2-level:\s*(\d+)/)?.[1] ?? "0",
    more: attributes!.includes("data-more"),
  }));
  expect(lines).toEqual([
    { text: "Handbuch", level: "0", more: false },
    { text: "Wareneingang", level: "0", more: false },
    { text: "Annahme prüfen", level: "1", more: false },
    { text: "Kühlware", level: "2", more: false },
    // a level deeper than the deepest indent stands at the deepest one
    { text: "zu tief", level: "6", more: false },
    { text: "+12 weitere Seiten", level: "0", more: true },
  ]);
  // the lines stand after the figures, inside the card
  expect(markup.indexOf("5 Seiten")).toBeLessThan(markup.indexOf("k2-tile-lines"));
});

test("the lines are text: a card that opens keeps its name as its one way in", () => {
  const link = html(Tiles, { variant: "card", items: [handbook] });
  expect(link.split("<a ").length - 1).toBe(1);
  const deed = html(Tiles, { variant: "card", items: [{ ...handbook, href: undefined, onOpen: () => {} }] });
  expect(deed.split("<button").length - 1).toBe(1);
  expect(deed).not.toContain("<a ");
});

test("a card without lines has no lines part, and lines belong to cards only", () => {
  expect(html(Tiles, { variant: "card", items: [{ icon: "book", title: "Leer" }] })).not.toContain("k2-tile-lines");
  expect(html(Tiles, { items: [handbook] })).not.toContain("k2-tile-lines");
});

test("cards share a row up to perRow; other tiles and cards without it keep their grid", () => {
  const shared = html(Tiles, { variant: "card", perRow: 3, items: [handbook] });
  expect(shared).toMatch(/class="k2-tiles"[^>]*data-per-row/);
  expect(shared).toMatch(/--k2-per-row:\s*3/);
  expect(html(Tiles, { variant: "card", items: [handbook] })).not.toContain("data-per-row");
  expect(html(Tiles, { perRow: 3, items: [handbook] })).not.toContain("data-per-row");
  expect(html(Tiles, { variant: "media", perRow: 3, items: [handbook] })).not.toContain("data-per-row");
});
