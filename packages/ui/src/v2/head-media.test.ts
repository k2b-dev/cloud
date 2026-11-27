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
const { Mark, Preview, Spark, Ticks } = await import("./marks");
const { Hero, ObjectHead, Trend } = await import("./identity");
const { Cells, Tiles } = await import("./layout");
const { Nav, Path } = await import("./components");
const { Choice, Input, Select, Setting } = await import("./controls");
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
  // the word "geändert" stands in a part of its own (it gives way on a narrow phone); read as text it is one sentence
  expect(markup.replace(/<[^>]+>/g, "")).toContain("geändert · vorher 12 Std.");
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

test("a deep path folds on the server already: first place, the menu with every place between, the page, and short names marked", () => {
  const items = ["Werkstatt", "Projekte", "2026", "Kunden", "Lindqvist", "Küche", "Q1"].map((label, index, all) =>
    index < all.length - 1 ? { label, href: `#${index}` } : { label },
  );
  const markup = html(Path, { label: "Ort", items });
  // the menu's button stands in the markup with its name; the places between are not in the line
  expect(markup).toContain('aria-label="Übergeordnete Ebenen"');
  for (const folded of ["Projekte", "2026", "Kunden", "Lindqvist", "Küche"]) expect(markup).not.toContain(`>${folded}<`);
  expect(markup).toMatch(/<a class="k2-path-step" href="#0"[^>]*title="Werkstatt"/);
  expect(markup).toMatch(/<b aria-current="page" title="Q1" data-short=""/);
  // unfolded, the places between carry the mark that lets them shorten first
  expect(html(Path, { label: "Ort", items: items.slice(-3) })).toMatch(/<a class="k2-path-step" href="#5" data-near=""[^>]*title="Küche"/);
  // up to four places nothing folds
  expect(html(Path, { label: "Ort", items: items.slice(-4) })).not.toContain("Übergeordnete Ebenen");
});

test("a setting with a deed shows it once, whatever control it names (merge guard: #4191 and #4226 once kept two)", () => {
  const action = { label: "Auf Standard zurücksetzen", icon: "arrow-back-up" };
  const controls = [
    createComponent(Input, { type: "number", value: "8" }),
    createComponent(Select, { options: ["8 Std.", "12 Std."], value: "8 Std." }),
    createComponent(Choice, { name: "bleiben", options: ["Aus", "An"], value: "An" }),
  ];
  for (const children of controls) {
    const markup = html(Setting, { label: "Angemeldet bleiben", action, children });
    expect(markup.split("k2-field-action").length - 1).toBe(1);
    expect(markup.split("Auf Standard zurücksetzen").length - 1).toBe(1);
  }
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

test("a value with a limit shows a meter inside the limit, says the value in words, and a limit of nothing shows none", () => {
  const over = html(Cells.Cell, { icon: "clock", label: "Arbeitszeit", value: "4 von 3 h", meter: { value: 4, of: 3 } });
  expect(over).toContain('role="meter"');
  expect(over).toContain('aria-valuenow="3"');
  expect(over).toContain('aria-valuemax="3"');
  expect(over).toContain('aria-valuetext="4 von 3 h"');
  expect(over).toContain("data-full");
  expect(over).toContain("--k2-p:100%");
  const part = html(Cells.Cell, { icon: "clock", label: "Arbeitszeit", value: "1,5 von 3 h", meter: { value: 1.5, of: 3 } });
  expect(part).toContain("--k2-p:50%");
  expect(part).not.toContain("data-full");
  expect(html(Cells.Cell, { icon: "clock", label: "Arbeitszeit", value: "0 h", meter: { value: 0, of: 0 } })).not.toContain('role="meter"');
});

test("a thing without a symbol shows the first letter of its name on its colour, a whole letter or emoji", () => {
  const letter = (initial: string) => html(Mark, { initial, color: "#0284c7" }).match(/k2-mk-initial[^>]*>([^<]*)</)?.[1];
  expect(letter("werkstatt")).toBe("W");
  expect(letter("  Ärzte Nord")).toBe("Ä");
  expect(letter("🎨 Atelier")).toBe("🎨");
  // the letter stands in the symbol's place: no symbol beside it
  expect(html(Mark, { initial: "Werkstatt" })).not.toContain("ti-");
});

test("key numbers count themselves on the server: the cells say how many they are and each its place", () => {
  const markup = html(Cells, {
    get children() {
      return ["Aufträge", "Offen", "Erledigt"].map((label, index) =>
        createComponent(Cells.Cell, { icon: "circle", label, value: String(index + 1) }),
      );
    },
  });
  expect(markup).toMatch(/class="k2-cells"[^>]*data-n="3"/);
  expect([...markup.matchAll(/data-k2-part="Cells.Cell" data-i="(\d)"/g)].map((match) => match[1])).toEqual(["1", "2", "3"]);
});

test("a media tile may open by a deed: its title is a button, and the tile is marked as one that opens", () => {
  const markup = html(Tiles, {
    variant: "media",
    label: "Notizen",
    items: [{ key: "n", icon: "note", title: "Notiz zur Abnahme", onOpen: () => {} }],
  });
  expect(markup).toMatch(/class="k2-tile"[^>]*data-open=""/);
  expect(markup).toMatch(/<button type="button" class="k2-row-open"[^>]*>Notiz zur Abnahme</);
});

test("a hero comes whole from the server: the figure in its role, the history named, the exceptions with their who", () => {
  const markup = html(Hero, {
    figure: "178",
    label: "aktive Verbindungen",
    trend: { kind: "bars", values: [1, 0, 3], label: "Neue Verbindungen je Tag", caption: "je Tag" },
    exceptions: [{ status: "warn", count: 1, word: "ungenutzt", who: "MCP Inspector" }],
  });
  expect(markup).toMatch(/data-k2-type="figure"[^>]*>178</);
  expect(markup).toContain('aria-label="Neue Verbindungen je Tag"');
  // who stands quietly after the words, without a "·" (the study's exception line)
  expect(markup).toContain(">MCP Inspector<");
  expect(markup).not.toContain("· MCP Inspector");
  // a failure from the very first value is drawn, one past the last is none
  const area = (failedFrom: number) =>
    html(Hero, { figure: "1", label: "Werte", trend: { kind: "area", values: [1, 2, 3], label: "Werte", failedFrom } });
  expect(area(0)).toContain("k2-hero-failed");
  expect(area(3)).not.toContain("k2-hero-failed");
  // an area of one value draws no line: its place stands empty and keeps its height
  const one = html(Hero, { figure: "1", label: "Werte", trend: { kind: "area", values: [4], label: "Werte", empty: "Noch keine Werte" } });
  expect(one).toContain('class="k2-hero-none"');
  expect(one).not.toContain("k2-hero-line");
});

test("the head of an open thing and the ticks come whole from the server", () => {
  const head = html(ObjectHead, {
    mark: { icon: "printer" },
    name: "Drucker Halle 2",
    facts: [{ label: "Verbunden", value: "6 von 6" }],
    problem: { title: "Liefert keine Werte" },
  });
  expect(head).toMatch(/<header class="k2-ohead" data-k2-part="ObjectHead">/);
  expect(head).toContain("<dt>Verbunden</dt>");
  expect(head).toContain("Liefert keine Werte");
  const ticks = html(Ticks, { slots: ["ok", "bad", "none"], label: "3 Abrufe" });
  expect([...ticks.matchAll(/data-s="(\w+)"/g)].map((match) => match[1])).toEqual(["ok", "bad", "none"]);
});

// a drawing is bounded by what its widest place can show (review r3 of #4360): a spark 23 bars or 40 points of a line,
// a history 470 values, the newest; so a long series neither grows the page nor the time to draw it
test("a spark and a history draw only their newest values, fast, however long the series", () => {
  const long = Array.from({ length: 20_000 }, (_, index) => index % 97);
  const started = performance.now();
  const bars = html(Spark, { values: long, label: "lang" });
  const line = html(Spark, { values: long, label: "lang", kind: "line" });
  const trend = html(Trend, { kind: "bars", values: long, label: "lang" });
  const area = html(Trend, {
    kind: "area",
    values: long,
    failedFrom: long.length - 3,
    label: "lang",
    ticks: { slots: long.map((_, index) => (index >= long.length - 3 ? "bad" : "ok")), label: "Abrufe" },
  });
  const took = performance.now() - started;
  expect(bars.match(/<i /g)?.length).toBe(23);
  expect(line.match(/[ML]/g)?.length).toBe(40);
  expect(trend.match(/<rect /g)?.length).toBe(470);
  // the area's newest 470 values over the newest 470 ticks, the last three failed
  expect(/class="k2-hero-line" d="([^"]*)"/.exec(area)?.[1]?.match(/[ML]/g)?.length).toBe(470);
  expect(area.match(/data-s="bad"/g)?.length).toBe(3);
  expect(area).toContain('class="k2-hero-cut"');
  // linear: four drawings of 20.000 values in well under a second (quadratic took seconds each)
  expect(took).toBeLessThan(1000);
});

test("a spark line skips what is no number and scales negative values between their lowest and highest", () => {
  const path = (values: number[]) => /<path d="([^"]*)"/.exec(html(Spark, { values, label: "x", kind: "line" }))?.[1] ?? "";
  // a gap: the line breaks and goes on, nothing NaN in the path
  const gap = path([1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY, 4]);
  expect(gap).not.toContain("NaN");
  expect(gap.match(/M/g)?.length).toBe(3);
  // all negative: the highest value at the top (y 2), the lowest at the bottom (y 18)
  expect(path([-5, -1, -3])).toBe("M0.0,18.0l0,0L40.0,2.0L80.0,10.0");
  // equal values, also negative ones: a flat line in the middle
  expect(path([-2, -2, -2])).toBe("M0.0,10.0l0,0L40.0,10.0L80.0,10.0");
});
