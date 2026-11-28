import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// Words read sign by sign (a route in a table cell, a path, an ID) stand in monospace through `Text mono`, the same
// meaning `Facts` gives a value with `mono`; an app never sets a font itself.

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-text-mono-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Text } = await import("./index");
const markup = (props: Parameters<typeof Text>[0]) => renderToString(() => createComponent(Text, props));

test("`mono` marks the words, and only them, as read sign by sign", () => {
  expect(markup({ mono: true, children: "/api/pulse/streams" })).toMatch(/^<span[^>]*\sdata-mono=""[^>]*>\/api\/pulse\/streams<\/span>$/);
  expect(markup({ children: "Pulse" })).not.toContain("data-mono");
  expect(markup({ mono: false, children: "Pulse" })).not.toContain("data-mono");
});

test("the stylesheet sets monospace for marked words from the mono token, in the type role of their place", () => {
  const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
  const rule = css.match(/\.k2-ui \.k2-text\[data-mono\] \{[^}]*\}/)?.[0] ?? "";
  expect(rule).toContain("font-family: var(--k2-font-mono);");
  // a size of its own (0.923em was 11.999 px on a 20 px line) leaves the type roles; measureV2Layout reports it
  expect(rule).not.toContain("font-size");
});
