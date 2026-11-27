import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// What the server sends for a primitive is what the browser shows on its first render: these cases differed (#4147,
// #4148). The v2 modules are Solid modules (`.tsx`), compiled by the registered plugin, so they are imported after it.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-server-markup-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Pane } = await import("./layout");
const { Input } = await import("./controls");
const { Text } = await import("./content");

const split = (more: JSX.Element) =>
  renderToString(() =>
    createComponent(Pane.Split, {
      get children() {
        return [createComponent(Pane, { label: "Liste", children: createComponent(Text, { children: "Eintrag" }) }), more];
      },
    }),
  );
const seams = (markup: string) => markup.match(/class="k2-seam"/g)?.length ?? 0;

test("a split draws no seam for a child that renders nothing, so `{open && <Pane …/>}` draws one line", () => {
  const alone = seams(split(undefined));
  expect(alone).toBe(1);
  for (const nothing of [false, true, null, ""]) expect(seams(split(nothing))).toBe(alone);
});

// HTML drops one newline at the start of a textarea's text: the server sends one more, so leading blank lines stay.
test("a multi-line field sends its value as the text of its textarea, leading blank lines too", () => {
  for (const value of ["Zwei <Zeilen>\nund mehr", "\nErste\nZweite", "\n\nNach zwei Leerzeilen", ""]) {
    const markup = renderToString(() => createComponent(Input, { multiline: true, label: "Notiz", value }));
    expect(markup).toContain(`>\n${value.replaceAll("<", "&lt;")}</textarea>`);
  }
  // no value: an empty textarea
  expect(renderToString(() => createComponent(Input, { multiline: true, label: "Notiz" }))).toContain(">\n</textarea>");
});

// A password manager reads the server's markup, before the island hydrates: what it may fill in stands there (#4173).
test("a text field sends autocomplete, length, keyboard, spelling and capitals in the server's markup", () => {
  const markup = renderToString(() =>
    createComponent(Input, {
      label: "Code",
      name: "code",
      type: "password",
      autocomplete: "one-time-code",
      maxLength: 8,
      inputMode: "numeric",
      spellcheck: false,
      autocapitalize: "off",
    }),
  );
  const input = markup.match(/<input[^>]*>/)?.[0] ?? "";
  for (const attribute of [
    'name="code"',
    'autocomplete="one-time-code"',
    'maxlength="8"',
    'inputmode="numeric"',
    'spellcheck="false"',
    'autocapitalize="off"',
  ])
    expect(input).toContain(attribute);
  expect(renderToString(() => createComponent(Input, { multiline: true, label: "Notiz", spellcheck: true }))).toContain(
    'spellcheck="true"',
  );
  // without them the field stays as it was: no attribute is guessed
  expect(renderToString(() => createComponent(Input, { label: "Suche" }))).not.toMatch(
    /autocomplete|maxlength|inputmode|spellcheck|autocapitalize/,
  );
});

test("Ticks are drawn by the server alone: a picture with its sentence and one tick per slot", async () => {
  const { Ticks } = await import("./marks");
  const markup = renderToString(() =>
    createComponent(Ticks, { slots: ["none", "ok", "bad"], label: "Quelle: 2 Abrufe, 1 fehlgeschlagen", color: "#7c3aed" }),
  );
  expect(markup).toContain('role="img"');
  expect(markup).toContain('aria-label="Quelle: 2 Abrufe, 1 fehlgeschlagen"');
  expect(markup.match(/<i data-s="(ok|bad|none)"/g)).toEqual(['<i data-s="none"', '<i data-s="ok"', '<i data-s="bad"']);
  expect(markup).toContain("--k2-c:#7c3aed");
});

test("a RangeBar is drawn by the server alone: its words, its place on the scale and the colours of its part", async () => {
  const { RangeBar } = await import("./marks");
  const markup = renderToString(() =>
    createComponent(RangeBar, {
      from: 0,
      to: 10,
      domain: [-10, 30],
      stops: [
        { at: 0, color: "#0369a1" },
        { at: 10, color: "#15803d" },
      ],
      label: "0° bis 10°",
    }),
  );
  expect(markup).toContain('role="img"');
  expect(markup).toContain('aria-label="0° bis 10°"');
  // a quarter in from the start, half the scale short of its end
  expect(markup).toContain("--k2-range-start:25%");
  expect(markup).toContain("--k2-range-end:50%");
  expect(markup).toContain("--k2-range-fill:linear-gradient(var(--k2-range-way, to right), #0369a1 0%, #15803d 100%)");
});

test("a RangeBar reads from and to in either order, holds a range past its scale to the scale, and stays empty without numbers", async () => {
  const { RangeBar } = await import("./marks");
  const draw = (from: number, to: number) =>
    renderToString(() => createComponent(RangeBar, { from, to, domain: [0, 10], label: "Bereich" }));
  // the order does not matter
  expect(draw(8, 2)).toBe(draw(2, 8));
  // past the scale: held to its ends
  const past = draw(-5, 15);
  expect(past).toContain("--k2-range-start:0%");
  expect(past).toContain("--k2-range-end:0%");
  // at the scale's very end: a stub that stands at the end (the CSS keeps its 4 px inside the track)
  expect(draw(10, 10)).toContain("--k2-range-start:100%");
  // no number: the track alone, no range on it
  expect(draw(Number.NaN, 3)).not.toContain("<i");
  expect(renderToString(() => createComponent(RangeBar, { from: 1, to: 2, domain: [5, 5], label: "leer" }))).not.toContain("<i");
});

test("a RangeBar's colours are colours: stops sorted, held to the visible part, and anything else dropped", async () => {
  const { RangeBar } = await import("./marks");
  const markup = renderToString(() =>
    createComponent(RangeBar, {
      from: -20,
      to: 5,
      domain: [-10, 10],
      stops: [
        { at: 10, color: "#15803d" },
        { at: 0, color: "red), url(https://example.org/x.png), linear-gradient(red" },
        { at: -10, color: "light-dark(#1d4ed8, #93c5fd)" },
        { at: 0, color: "#0369a1;background:url(https://example.org/x.png)" },
      ],
      label: "-10° bis 5°",
    }),
  );
  expect(markup).not.toContain("url(");
  // the visible part runs from -10 to 5: the stops sit at their place on it, in the order of the scale
  expect(markup).toContain(
    "--k2-range-fill:linear-gradient(var(--k2-range-way, to right), light-dark(#1d4ed8, #93c5fd) 0%, #15803d 133.3%)",
  );
});

test("a decorative RangeBar says nothing to assistive technology", async () => {
  const { RangeBar } = await import("./marks");
  const markup = renderToString(() => createComponent(RangeBar, { from: 1, to: 2, domain: [0, 4], decorative: true }));
  // as a decorative Avatar: hidden from assistive technology, without words of its own
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain("aria-label");
});

test("an Icon takes a data colour as a checked --k2-c, and drops what is no colour", async () => {
  const { Icon } = await import("./marks");
  const colored = renderToString(() => createComponent(Icon, { name: "sun", color: "light-dark(#b45309, #fbbf24)" }));
  expect(colored).toContain("--k2-c:light-dark(#b45309, #fbbf24)");
  expect(colored).toContain("data-color");
  for (const color of ["red;background:url(https://example.org/x.png)", "red", "light-dark(#fff, red)"]) {
    const markup = renderToString(() => createComponent(Icon, { name: "sun", color }));
    expect(markup).not.toMatch(/--k2-c|url\(|background/);
    expect(markup).not.toContain("data-color");
  }
});
