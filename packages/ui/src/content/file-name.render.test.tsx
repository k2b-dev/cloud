import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-file-name-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { FileName } = await import("./FileName");

test("a file name gives assistive technology the whole name once and hides the two visible parts", () => {
  const html = renderToString(() => createComponent(FileName, { name: "Notes.txt" }));
  expect(html).toContain('title="Notes.txt"');
  expect(html).toMatch(/<span class="k2b-sr-only">Notes\.txt<\/span>/);
  expect(html).toMatch(/<span class="k2b-file-name__stem" aria-hidden="true">Notes<\/span>/);
  expect(html).toMatch(/<span class="k2b-file-name__ext" aria-hidden="true">\.txt<\/span>/);
  // A name without an ending keeps one visible part, also hidden behind the whole name.
  const plain = renderToString(() => createComponent(FileName, { name: "README" }));
  expect(plain).toMatch(
    /<span class="k2b-sr-only">README<\/span><span class="k2b-file-name__stem" aria-hidden="true">README<\/span><\/span>$/,
  );
});
