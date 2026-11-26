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
const { Button } = await import("./button");
const { Menu } = await import("./menu");
const { Popover } = await import("./popover");

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

// The name of a button is its words, and a `label` beside them is a hint. A count or a symbol says no deed on its own:
// beside one, the label is the name ("2" for "2 offene Kommentare") and holds it, so a person who says what they see
// still reaches it.
test("a button is named by its words; a count or a symbol beside them by its label, which then holds the count", () => {
  const tag = (markup: string) => markup.match(/<(button|a)\b[^>]*>/)?.[0] ?? "";
  const count = tag(renderToString(() => createComponent(Button, { icon: "message-circle", label: "2 offene Kommentare", children: "2" })));
  expect(count).toContain('aria-label="2 offene Kommentare"');
  expect(tag(renderToString(() => createComponent(Button, { children: "Speichern" })))).not.toContain("aria-label");
  // beside words a label is a hint: the words stay the name, as what a person sees and says
  const words = tag(renderToString(() => createComponent(Button, { label: "Absender ändern", children: "Von Anna Berg" })));
  expect(words).not.toContain("aria-label");
  expect(words).toContain('title="Absender ändern"');
  expect(tag(renderToString(() => createComponent(Button, { icon: "x", label: "Schließen" })))).toContain('aria-label="Schließen"');
  // a count is also its hint, for a person with a mouse, who sees only the "2"
  expect(count).toContain('title="2 offene Kommentare"');
  // content that is an element shows words of its own: they stay the name, and the label is a hint
  const element = tag(
    renderToString(() =>
      createComponent(Button, { label: "Absender ändern", children: createComponent(Text, { children: "Von Anna Berg" }) }),
    ),
  );
  expect(element).not.toContain("aria-label");
  expect(element).toContain('title="Absender ändern"');
  // a short count with a letter ("1.2k") is words; a label that only repeats the words is no second hint
  expect(tag(renderToString(() => createComponent(Button, { label: "1.2k Aufrufe", children: "1.2k" })))).not.toContain("aria-label");
  expect(tag(renderToString(() => createComponent(Button, { label: "Ansicht", children: "Ansicht" })))).not.toContain("title=");
  // the buttons of a menu and of a popover follow the same rule
  const menu = tag(
    renderToString(() => createComponent(Menu, { label: "3 weitere Ansichten", children: "3", items: [{ label: "Liste" }] })),
  );
  expect(menu).toContain('aria-label="3 weitere Ansichten"');
  const popover = tag(renderToString(() => createComponent(Popover, { label: "2 Filter aktiv", children: "2", content: "Filter" })));
  expect(popover).toContain('aria-label="2 Filter aktiv"');
});
