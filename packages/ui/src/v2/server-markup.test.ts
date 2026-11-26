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
const { Text, QrCode, CodeDisplay } = await import("./content");
const { Notice } = await import("./components");
const { Section } = await import("./structure");

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

// Pairing a device (#4173): a waiting state is heard politely, a section is a link target, a QR code is a named
// picture whose markup never runs, and a code to compare is heard character by character.
test("a waiting notice is a status, a section takes an anchor, a QR code and a code to compare are named", () => {
  const notice = (tone: "bad" | "warn" | "note" | "ai") => renderToString(() => createComponent(Notice, { tone, children: "Wartet" }));
  expect(notice("bad")).toContain('role="alert"');
  expect(notice("warn")).toContain('role="status"');
  expect(notice("note")).toContain('role="note"');
  expect(notice("ai")).toContain('role="note"');
  expect(renderToString(() => createComponent(Section, { title: "Bildschirm", id: "screen" }))).toContain('id="screen"');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
  const qr = renderToString(() => createComponent(QrCode, { svg, label: "QR-Code zum Koppeln" }));
  expect(qr).toContain('alt="QR-Code zum Koppeln"');
  expect(qr).toContain(`src="data:image/svg+xml,${encodeURIComponent(svg)}"`);
  expect(qr).not.toContain("<script>");
  const code = renderToString(() => createComponent(CodeDisplay, { value: "482 913", label: "Vergleichscode" }));
  expect(code).toContain('aria-label="Vergleichscode: 4 8 2 9 1 3"');
  expect(code).toContain(">482 913<");
});
