import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-dot-strip-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DotStrip } = await import("./DotStrip");
const strip = (props: Parameters<typeof DotStrip>[0]) => renderToString(() => createComponent(DotStrip, props));
const css = readFileSync(resolve(import.meta.dir, "../styles/surfaces-widgets-parity.css"), "utf8");

test("a run strip draws bars whose form, not only colour, carries the state", () => {
  const runs = strip({ dots: ["success", "danger", "skipped", "running", "planned"], shape: "bar", size: "lg", label: "Last 5 runs" });
  expect(runs).toContain('data-shape="bar"');
  expect(runs).toContain('data-size="lg"');
  for (const state of ["success", "danger", "skipped", "running", "planned"]) expect(runs).toContain(`data-state="${state}"`);
  // No links: the strip stays one image with one name.
  expect(runs).toContain('role="img"');
  expect(runs).not.toContain("<a ");
  // Failed is interrupted, skipped and planned are short, running is a ring that pulses.
  expect(css).toMatch(/data-shape="bar"\]\[data-size="lg"\] \.k2b-dot-strip__dot\[data-state="danger"\] \{ background: linear-gradient\(/);
  expect(css).toMatch(/\.k2b-dot-strip__dot:is\(\[data-state="skipped"\], \[data-state="pending"\]\) \{ height: 6px;/);
  expect(css).toMatch(/\.k2b-dot-strip__dot\[data-state="planned"\] \{ width: 4px; height: 8px;/);
  expect(css).toMatch(/\.k2b-dot-strip__live-ai\[data-state="running"\] \{[^}]*animation: k2b-dot-strip-running 1\.1s/);
  // Only the running slot carries the AI palette, through its own `-ai` class.
  expect(runs.match(/k2b-dot-strip__live-ai/g)).toHaveLength(1);
  expect(css).toMatch(/\[data-shape="bar"\]\[data-size="lg"\] \.k2b-dot-strip__dot \{ width: 5px; height: 22px; border-radius: 2\.5px; \}/);
});

test("each slot with a link opens its item, named for assistive technology", () => {
  const linked = strip({
    dots: ["success", "danger", "success"],
    shape: "bar",
    label: "Last 3 runs, 1 failed",
    hrefs: ["?tab=runs&run=a", "?tab=runs&run=b", undefined],
    labels: ["13:15: successful", "13:30: failed", "13:45: successful"],
  });
  expect(linked).toContain('role="list"');
  expect(linked).toContain('aria-label="Last 3 runs, 1 failed"');
  expect(linked.match(/<a class="k2b-dot-strip__link" role="listitem"/g)).toHaveLength(2);
  expect(linked).toContain('href="?tab=runs&amp;run=b" aria-label="13:30: failed"');
  // The slot without a link stays a plain mark.
  expect(linked.match(/class="k2b-dot-strip__dot"/g)).toHaveLength(3);
});

test("the dot strip keeps its earlier contract: round dots by default, a still first render", () => {
  const dots = strip({ dots: ["accent", "muted"], length: 3, label: "2 of 3" });
  expect(dots).toContain('data-shape="dot"');
  expect(dots).toContain('role="img"');
  expect(dots.match(/data-state="pending"/g)).toHaveLength(1);
  expect(dots).not.toContain("data-settled");
});
