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
const { Pane, Workspace } = await import("./layout");
const { Input } = await import("./controls");
const { Text } = await import("./content");
const { Heat } = await import("./heat");

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

// The place of a declared detail stands only while no detail is open, on the server as in the browser: an open detail
// registers itself while it renders, so the server must decide where it draws the place, never ahead (#4445 review).
test("a workspace draws the empty detail's place only while no detail is open, also on the server", () => {
  const page = (open: boolean) =>
    renderToString(() =>
      createComponent(Workspace, {
        detail: true,
        detailEmpty: { icon: "mail", text: "Keine Nachricht ausgewählt" },
        get children() {
          return createComponent(Pane.Split, {
            get children() {
              return [
                createComponent(Pane, { label: "Liste", children: createComponent(Text, { children: "Eintrag" }) }),
                open
                  ? createComponent(Pane, { label: "Nachricht", detail: true, children: createComponent(Text, { children: "Text" }) })
                  : undefined,
              ];
            },
          });
        },
      }),
    );
  expect(page(true)).not.toContain("data-detail-empty");
  expect(page(false)).toContain("data-detail-empty");
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

// A Heat is drawn whole by the server: every day of the 53 weeks with its tone and words, today marked and the one Tab
// stop, so the first paint needs no script and no measuring.
test("a heat sends every day of its 53 weeks, today marked, in the server's markup", () => {
  const markup = renderToString(() =>
    createComponent(Heat, {
      days: [{ date: "2026-11-27", count: 3 }],
      today: "2026-11-27",
      label: "Mails pro Tag",
      unit: (count: number) => `${count} Mails`,
    }),
  );
  // weeks from Sunday in English: Sunday to Friday reach this week, Saturday stops at the week before
  expect(markup.match(/role="gridcell"/g)).toHaveLength(370);
  expect(markup).toContain('role="grid"');
  expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  // one day with a count is the strongest tone
  expect(markup).toMatch(/data-tone="4" aria-label="Fri, Nov 27 · 3 Mails" aria-current="date"/);
});
