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
const { List, Row, Table, Text } = await import("./content");
const { SERVER_ROWS } = await import("./virtual");

// A list of any length sends its first rows and holds the place of the rest, so the server's work stays bounded and
// the browser's first render is the same page (break-ui 25.11.: 1,000 conversations took 7.3 s and 10.6k nodes).
test("a list of items sends only its first rows, each saying where it stands, and holds the place of the rest", () => {
  const items = Array.from({ length: 1000 }, (_, index) => ({ id: `c${index}`, title: `Gespräch ${index + 1}` }));
  const markup = renderToString(() =>
    createComponent(List<(typeof items)[number]>, {
      label: "Gespräche",
      items,
      rowKey: (item) => item.id,
      row: (item) => createComponent(Row, { lines: [item.title] }),
    }),
  );
  expect(markup.match(/data-k2-part="Row"/g)?.length).toBe(SERVER_ROWS);
  expect(markup).toContain('aria-setsize="1000"');
  expect(markup).toContain('aria-posinset="1"');
  expect(markup).toContain(`--k2-after:${(1000 - SERVER_ROWS) * 40}px`);
  const table = renderToString(() =>
    createComponent(Table<(typeof items)[number]>, {
      label: "Gespräche",
      rows: items,
      columns: [{ title: "Titel", cell: (item) => item.title }],
    }),
  );
  expect(table.match(/<tr aria-rowindex/g)?.length).toBe(SERVER_ROWS);
  expect(table).toContain('aria-rowcount="1001"');
});

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
