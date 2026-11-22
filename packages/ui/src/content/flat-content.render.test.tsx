import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-flat-content-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { TaskRow } = await import("./TaskRow");
const { ProgressPath } = await import("./ProgressPath");

const row = (props: Parameters<typeof TaskRow>[0]) => renderToString(() => createComponent(TaskRow, props));

test("TaskRow is one link or one button with no control inside, and the full sentence as the no-JavaScript hint", () => {
  const link = row({
    icon: "ti ti-package-export",
    count: 3,
    text: "Items are ready",
    detail: "until Dec 12",
    action: "Prepare",
    href: "/h",
  });
  expect(link).toMatch(/^<a [^>]*class="k2b-task-row ?"[^>]*href="\/h"[^>]*data-detail=""[^>]*title="Items are ready"/);
  expect(link).toContain('<span class="k2b-count-chip">3</span>');
  expect(link).toContain('<span class="k2b-task-row__action">Prepare</span>');
  expect(link.slice(link.indexOf(">") + 1, link.indexOf("</a>"))).not.toMatch(/<(a|button)\b/);

  const button = row({ icon: "ti ti-file", text: "Send it", action: "Open", onClick: () => undefined });
  expect(button).toMatch(/^<button [^>]*type="button"/);
  expect(button).not.toContain("data-detail");
  expect(button).not.toContain("k2b-count-chip");
});

test("A disabled TaskRow keeps its place: a native disabled button, or a link without a target", () => {
  expect(row({ icon: "ti ti-file", text: "Sign", action: "Sign", onClick: () => undefined, disabled: true })).toMatch(
    /^<button [^>]*disabled/,
  );
  const link = row({ icon: "ti ti-file", text: "Sign", action: "Sign", href: "/s", disabled: true });
  expect(link).toMatch(/^<a [^>]*aria-disabled="true"/);
  expect(link).not.toContain("href=");
});

test("ProgressPath names each state in words and marks the current step", () => {
  const html = renderToString(() =>
    createComponent(ProgressPath, {
      label: "Order",
      steps: [
        { label: "Ordered", done: true },
        { label: "Packed", done: true, current: true },
        { label: "Shipped", icon: "ti ti-truck" },
      ],
    }),
  );
  expect(html).toContain('data-state="done"');
  // One word for the state: no aria-current, which would read "current step" a second time.
  expect(html).toMatch(/data-state="current"><span class="k2b-progress-path__marker" aria-hidden="true"><\/span>/);
  expect(html).not.toContain("aria-current");
  expect(html).toContain('Packed<span class="k2b-sr-only">, current step</span>');
  // A slim dot carries no symbol, also for an open step with the deprecated icon.
  expect(html).toContain('data-state="open"><span class="k2b-progress-path__marker" aria-hidden="true"></span>');
  expect(html).toContain('Shipped<span class="k2b-sr-only">, not yet</span>');
});
