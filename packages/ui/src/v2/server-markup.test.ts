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
const { Pane, Tiles, Workspace } = await import("./layout");
const { Input } = await import("./controls");
const { List, Row, Text } = await import("./content");
const { Empty } = await import("./states");
const { Heat } = await import("./heat");
const { Tabs } = await import("./components");

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
// A first start in the middle of the page (W2/W4): the server's markup already places it, so nothing moves when the
// page hydrates. Both are CSS alone, set by the attributes and the one inline value the server sends.
test("a centred pane and tiles that share a row are placed by the server's markup alone", () => {
  const pane = renderToString(() => createComponent(Pane, { label: "Notizbücher", center: true, children: "Start" }));
  expect(pane).toMatch(/<section[^>]*class="k2-pane"[^>]*data-center=""/);
  expect(renderToString(() => createComponent(Pane, { label: "Notizbücher", children: "Start" }))).not.toContain("data-center");
  const tiles = (perRow?: number) =>
    renderToString(() => createComponent(Tiles, { label: "Wege", perRow, items: [{ icon: "notebook", title: "Tagebuch" }] }));
  expect(tiles(4)).toMatch(/data-per-row=""[^>]*style="--k2-per-row:\s*4;\s*--k2-per-row-half:\s*2"/);
  // where n do not fit, a row holds half of them, rounded up
  expect(tiles(3)).toMatch(/--k2-per-row-half:\s*2"/);
  // a count is a whole number of at least one
  expect(tiles(2.7)).toMatch(/--k2-per-row:\s*2;/);
  expect(tiles(-3)).toMatch(/--k2-per-row:\s*1;\s*--k2-per-row-half:\s*1"/);
  expect(tiles(undefined)).not.toContain("data-per-row");
  expect(tiles(undefined)).not.toContain("--k2-per-row");
});

test("a multi-line field sends its value as the text of its textarea, leading blank lines too", () => {
  for (const value of ["Zwei <Zeilen>\nund mehr", "\nErste\nZweite", "\n\nNach zwei Leerzeilen", ""]) {
    const markup = renderToString(() => createComponent(Input, { multiline: true, label: "Notiz", value }));
    expect(markup).toContain(`>\n${value.replaceAll("<", "&lt;")}</textarea>`);
  }
  // no value: an empty textarea
  expect(renderToString(() => createComponent(Input, { multiline: true, label: "Notiz" }))).toContain(">\n</textarea>");
});

// Without CSS `field-sizing` a field of several lines is as high as its rows: the server gives it the lines of its value
// (at least its `rows`, at most ten), so it does not grow when the page comes alive.
test("a multi-line field asks for the lines of its value on the server, from its rows up to ten", () => {
  const rows = (props: { value?: string; rows?: number }) =>
    /<textarea[^>]*\brows="(\d+)"/.exec(renderToString(() => createComponent(Input, { multiline: true, label: "Notiz", ...props })))?.[1];
  expect(rows({ value: "Eine Zeile" })).toBe("3");
  expect(rows({ value: "1\n2\n3\n4\n5\n6\n7\n8" })).toBe("8");
  expect(rows({ value: Array.from({ length: 14 }, (_, line) => `Zeile ${line}`).join("\n") })).toBe("10");
  expect(rows({ value: "Eine Zeile", rows: 5 })).toBe("5");
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

test("an empty state that went wrong carries its tone on its sign; a plain one stays neutral", () => {
  const sign = (markup: string) => markup.match(/<span class="k2-sign"[^>]*>/)?.[0] ?? "";
  const failed = renderToString(() =>
    createComponent(Empty, { icon: "alert-triangle", text: "Die Seite konnte nicht geöffnet werden.", tone: "bad" }),
  );
  expect(sign(failed)).toContain('data-tone="bad"');
  const waiting = renderToString(() => createComponent(Empty, { icon: "clock", text: "Der Dienst startet gerade.", tone: "warn" }));
  expect(sign(waiting)).toContain('data-tone="warn"');
  // without a tone nothing is guessed, and no retry appears: it is not `Failed`
  const plain = renderToString(() => createComponent(Empty, { icon: "inbox", text: "Noch keine Einlieferung." }));
  expect(sign(plain)).not.toContain("data-tone");
  expect(failed).not.toContain("refresh");
});

// A note's outline comes from the server already at its levels, heard as such before any script runs.
test("a row at a level sends it in the server's markup: aria-level in a list, the level for its step outside one", () => {
  const inList = renderToString(() =>
    createComponent(List, {
      label: "Inhalt",
      get children() {
        return [createComponent(Row, { lines: ["Werkstattordnung"], level: 1 }), createComponent(Row, { lines: ["Feiertage"], level: 3 })];
      },
    }),
  );
  expect(inList).toMatch(/role="listitem"[^>]*aria-level="3"|aria-level="3"[^>]*role="listitem"/);
  expect(inList).toContain('data-level="1"');
  // outside a list a row has no role, so no aria-level either; it still stands at its step
  const alone = renderToString(() => createComponent(Row, { lines: ["Feiertage"], level: 3 }));
  expect(alone).toContain('data-level="3"');
  expect(alone).not.toContain("aria-level");
  // a level outside 1..6 stands at the edge and says nothing, so it never voids the row's padding
  for (const level of [0, 7, 2.5]) {
    const odd = renderToString(() =>
      createComponent(List, {
        label: "Inhalt",
        get children() {
          // data that breaks the type, as a heading level read from a note may
          return createComponent(Row, { lines: ["Feiertage"], level: level as 1 });
        },
      }),
    );
    expect(odd).not.toContain("data-level");
    expect(odd).not.toContain("aria-level");
  }
});

// The page's live region is in the server markup: a region that exists before its first news is heard.
test("a Workspace brings the page's live region in its server markup: a status and an alert, empty", () => {
  const markup = renderToString(() => createComponent(Workspace, { children: createComponent(Pane, { label: "Liste", children: "" }) }));
  expect(markup).toContain('data-k2-part="Announcer"');
  expect(markup).toMatch(/role="status"[^>]*aria-live="polite"/);
  expect(markup).toMatch(/role="alert"[^>]*aria-live="assertive"/);
});

test("Failed writes out the button a `Button` with its icon and words draws, so a change to Button reaches it", async () => {
  const { Failed } = await import("./failed");
  const { Button } = await import("./button");
  const { resolveUiMessages } = await import("../intl/messages");
  // the same markup apart from hydration keys, Solid's markers and spacing inside a class list or before a tag's end
  const button = (markup: string) =>
    markup
      .match(/<button\b[\s\S]*?<\/button>/)?.[0]
      .replace(/ data-hk="[^"]*"/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+>/g, ">")
      .replace(/class="([^"]*)"/g, (_, names: string) => `class="${names.trim().split(/\s+/).join(" ")}"`);
  const failed = renderToString(() => createComponent(Failed, { text: "Nicht geladen.", onRetry: () => undefined }));
  const retry = resolveUiMessages().retry;
  const plain = renderToString(() => createComponent(Button, { icon: "refresh", children: retry }));
  expect(button(failed)).toBeDefined();
  expect(button(failed)).toBe(button(plain));
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

// Gateway Ops (C): the areas of a record carry the state of what they open, as nav entries do. The server sends the dot
// and its word, so the first picture shows and says the state.
test("a tab sends the dot of its state with its word, and a tab without a state none", () => {
  const markup = renderToString(() =>
    createComponent(Tabs, {
      label: "Infrastruktur",
      items: [
        { label: "Postgres", dot: "warn", current: true, href: "/postgres" },
        { label: "Valkey", dot: "ok", href: "/valkey" },
        { label: "NATS", href: "/nats" },
      ],
    }),
  );
  expect(markup.match(/class="k2-dot"/g)).toHaveLength(2);
  expect(markup).toMatch(/data-status="warn"[^>]*aria-label="Warning"/);
  expect(markup).toMatch(/data-status="ok"[^>]*aria-label="All clear"/);
});
