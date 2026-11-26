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
const { Empty } = await import("./states");

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

// A page of one task (a code to enter) focuses its field before any script runs; a field elsewhere does not.
test("a text field takes the focus from the server's markup only when it says so, and sends a form it does not stand in", () => {
  const input = (props: { autofocus?: boolean; form?: string }) =>
    renderToString(() => createComponent(Input, { label: "Code", name: "user_code", ...props })).match(/<input[^>]*>/)?.[0] ?? "";
  expect(input({ autofocus: true, form: "code-form" })).toMatch(/autofocus/);
  expect(input({ autofocus: true, form: "code-form" })).toContain('form="code-form"');
  expect(input({})).not.toMatch(/autofocus|form=/);
});

test("a submit button sends the form and the answer it names; a link carries none of them", () => {
  const button = renderToString(() =>
    createComponent(Button, { type: "submit", form: "decision", name: "decision", value: "deny", children: "Ablehnen" }),
  );
  for (const attribute of ['type="submit"', 'form="decision"', 'name="decision"', 'value="deny"']) expect(button).toContain(attribute);
  const link = renderToString(() =>
    createComponent(Button, { href: "/", form: "decision", name: "decision", value: "deny", children: "Start" }),
  );
  expect(link).not.toMatch(/form=|name=|value=/);
});

// role=status from the server is read as the page opens; assistive technology announces only a change of it.
test("an empty state that is a result is a status region with a toned sign; a plain one is neither", () => {
  const result = renderToString(() => createComponent(Empty, { icon: "circle-check", text: "Gerät verbunden", live: true, tone: "ok" }));
  expect(result).toContain('role="status"');
  expect(result).toContain('class="k2-sign" data-tone="ok"');
  const plain = renderToString(() => createComponent(Empty, { icon: "inbox", text: "Noch nichts." }));
  expect(plain).toContain('<div class="k2-state" data-k2-part="Empty"><span class="k2-sign"><');
});
