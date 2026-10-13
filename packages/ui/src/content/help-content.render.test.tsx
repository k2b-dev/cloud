import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-help-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LabelChip } = await import("./LabelChip");
const { Steps } = await import("./Steps");

test("LabelChip is inline text with an optional decorative icon", () => {
  const html = renderToString(() => createComponent(LabelChip, { icon: "ti ti-share", children: "Share" }));
  expect(html).toBe('<span class="k2b-label-chip"><i class="ti ti-share" aria-hidden="true"></i>Share</span>');
  expect(renderToString(() => createComponent(LabelChip, { children: "Share" }))).toBe('<span class="k2b-label-chip">Share</span>');
});
test("Steps keeps native ordered-list semantics and the starting counter", () => {
  const html = renderToString(() => createComponent(Steps, { start: 3, children: <li>Select Share.</li> }));
  expect(html).toContain('<ol class="k2b-steps" start="3"');
  expect(html).toContain("--k2b-steps-start:3");
  expect(html).toContain("<li>Select Share.</li>");
});
