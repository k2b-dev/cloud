import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-quick-create-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: QuickCreate } = await import("./QuickCreate");

test("QuickCreate renders shared Enter and Escape caps inside its decorative hint", () => {
  const html = renderToString(() =>
    createComponent(QuickCreate, {
      spaceId: "Space1",
      days: { first: "2026-10-14", last: "2026-10-14" },
      kind: "event",
      defaults: {},
      columnId: "Column1",
      onCreated() {},
      onMoreOptions() {},
    }),
  );
  expect(html.match(/class="k2b-kbd"/g)).toHaveLength(2);
  expect(html).toContain('<kbd class="k2b-kbd__key">↵</kbd>');
  expect(html).toContain('<kbd class="k2b-kbd__key">Esc</kbd>');
  expect(html).toMatch(/<span[^>]+aria-hidden="true"[^>]*>.*k2b-kbd/s);
});
