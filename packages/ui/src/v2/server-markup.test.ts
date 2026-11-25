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
