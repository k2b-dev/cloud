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
  expect(markup).toContain("--k2-range-fill:linear-gradient(to right, #0369a1 0%, #15803d 100%)");
});
