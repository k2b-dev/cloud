import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for the second part of the design pass: a setting with its unsaved change, the preview of an
// open file, media tiles in a selection, the quota of a storage. The first view comes whole from the server.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-head-media-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Preview } = await import("./marks");
const { Tiles } = await import("./layout");
const { Nav, Path } = await import("./components");
const { Input, Setting } = await import("./controls");
const { checkSettingMessages } = await import("./setting-messages");
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

test("the words of Setting exist in every language", () => {
  expect(checkSettingMessages()).toEqual([]);
});

test("a setting names its control and says what an unsaved change was", () => {
  const markup = html(Setting, {
    label: "Angemeldet bleiben",
    hint: "Danach muss man sich neu anmelden.",
    was: "12 Std.",
    children: createComponent(Input, { type: "number", value: "8" }),
  });
  expect(markup).toContain('data-k2-part="Setting"');
  expect(markup).toContain("data-setting");
  // the label names the control as in a field
  expect(markup).toMatch(/<label class="k2-field-label" id="([^"]+)" for="([^"]+)"/);
  expect(markup).toContain("geändert · vorher 12 Std.");
  expect(markup).toContain("Danach muss man sich neu anmelden.");
  // a setting without a change says nothing about it
  expect(html(Setting, { label: "Adresse", children: createComponent(Input, { value: "x" }) })).not.toContain("k2-field-was");
});

test("a preview names its picture and keeps the symbol under it", () => {
  const markup = html(Preview, { label: "Vorschau von Plan.pdf", icon: "file-type-pdf", color: "#dc2626", image: "/p.png", kind: "PDF" });
  expect(markup).toMatch(/^<div class="k2-mk k2-preview" data-k2-part="Preview"/);
  expect(markup).toContain('aria-label="Vorschau von Plan.pdf"');
  expect(markup).toContain("ti-file-type-pdf");
  expect(markup).toContain('src="/p.png"');
});

test("media tiles send their pictures, boxes named by their titles, and which are selected", () => {
  const markup = html(Tiles, {
    variant: "media",
    label: "Dateien",
    select: { selected: ["b"], onChange: () => {} },
    items: [
      {
        key: "a",
        icon: "photo",
        title: "Front.jpg",
        image: "/a.jpg",
        people: [{ name: "Felix Thal" }],
        meta: "heute",
        sign: { icon: "link", label: "Link" },
        href: "/f/a",
      },
      { key: "b", icon: "file-type-pdf", title: "Angebot.pdf", kind: "PDF" },
    ],
  });
  expect(markup).toContain('data-variant="media"');
  expect(markup).toContain("data-selecting");
  expect(markup.match(/type="checkbox"/g)?.length).toBe(2);
  expect(markup.match(/data-selected/g)?.length).toBe(1);
  // each box is named by its tile's title
  const title = markup.match(/<span class="k2-tile-title" id="([^"]+)"/)?.[1];
  expect(title).toBeDefined();
  expect(markup).toContain(`aria-labelledby="${title}"`);
  expect(markup).toContain('aria-label="Link"');
  expect(markup).toContain('href="/f/a"');
});

test("a quota is a meter with its words, amber from 75 % and red from 90 %", () => {
  const nav = (value: number) =>
    html(Nav, {
      title: "Dateien",
      icon: "folders",
      groups: [],
      quota: { label: "Werkstatt", value, of: 100, text: `${value} von 100 GB` },
    });
  expect(nav(38)).toContain('role="meter"');
  expect(nav(38)).toContain('aria-valuetext="38 von 100 GB"');
  expect(nav(38)).not.toContain('data-status="');
  expect(nav(80)).toContain('data-status="warn"');
  expect(nav(95)).toContain('data-status="bad"');
});

test("a deep path folds on the server already: first place, the menu, the last two, and short names marked", () => {
  const items = ["Werkstatt", "Projekte", "2026", "Kunden", "Lindqvist", "Küche", "Q1"].map((label, index, all) =>
    index < all.length - 1 ? { label, href: `#${index}` } : { label },
  );
  const markup = html(Path, { label: "Ort", items });
  // the menu's button stands in the markup with its name; the places between are not in the line
  expect(markup).toContain('aria-label="Übergeordnete Ebenen"');
  for (const folded of ["Projekte", "2026", "Kunden", "Lindqvist"]) expect(markup).not.toContain(`>${folded}<`);
  expect(markup).toContain('href="#0"');
  expect(markup).toMatch(/<a class="k2-path-step" href="#5" data-near=""[^>]*title="Küche"/);
  expect(markup).toMatch(/<b aria-current="page" title="Q1" data-short=""/);
  // up to four places nothing folds
  expect(html(Path, { label: "Ort", items: items.slice(-4) })).not.toContain("Übergeordnete Ebenen");
});

test("among media the place to make one is the last tile: a dashed picture with a plus, then what it makes", () => {
  const markup = html(Tiles, {
    variant: "media",
    label: "Ordner",
    items: [{ icon: "folder", title: "Aufmaß", href: "#aufmass" }],
    create: { title: "Neuer Ordner", meta: "oder Dateien hierher ziehen", onClick: () => {} },
  });
  expect(markup).toMatch(/data-create[^>]*>.*k2-tile-make.*Neuer Ordner.*oder Dateien hierher ziehen/s);
  expect(markup.indexOf("Aufmaß")).toBeLessThan(markup.indexOf("Neuer Ordner"));
});
