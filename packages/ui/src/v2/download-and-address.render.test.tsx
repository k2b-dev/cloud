import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// A link button that downloads (Grids, W4 #4345: the public document page offers its file): `download` reaches the
// anchor, as a bare attribute or with a file name, and only on a link that leads somewhere. And `addressOf` is public
// from @k2b/ui/v2 (Tools, W8 #4186). Both load the package's front door, which needs the SSR plugin.

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-button-download-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Button, addressOf } = await import("./index");
type Props = Parameters<typeof Button>[0];
const markup = (props: Props) => renderToString(() => createComponent(Button, props));
/** The attributes of the one element the button renders. */
const attributes = (html: string) => {
  const tag = html.match(/^<(\w+)([^>]*)>/);
  return {
    element: tag?.[1],
    download: tag?.[2]?.match(/\sdownload(?:="([^"]*)")?/)?.[1] ?? (/\sdownload[\s>=]/.test(`${tag?.[2]} `) ? "" : null),
  };
};

test("a link button with `download` downloads: a bare attribute, or the file name it gives", () => {
  expect(attributes(markup({ href: "/files/angebot.pdf", download: true, children: "Herunterladen" }))).toEqual({
    element: "a",
    download: "",
  });
  expect(attributes(markup({ href: "/files/angebot.pdf", download: "Angebot Küche.pdf", children: "Herunterladen" }))).toEqual({
    element: "a",
    download: "Angebot Küche.pdf",
  });
});

test("without `download`, with `download={false}`, on a disabled link or on a plain button there is no download", () => {
  for (const props of [
    { href: "/files/angebot.pdf", children: "Öffnen" },
    { href: "/files/angebot.pdf", download: false, children: "Öffnen" },
    { href: "/files/angebot.pdf", download: true, disabled: true, children: "Herunterladen" },
    { download: true, children: "Herunterladen" },
  ] satisfies Props[])
    expect(attributes(markup(props)).download).toBeNull();
});

test("addressOf is public from @k2b/ui/v2 and gives the bare address of a display form", () => {
  expect(addressOf('"Berg, Anna" <anna@example.org>')).toBe("anna@example.org");
});
