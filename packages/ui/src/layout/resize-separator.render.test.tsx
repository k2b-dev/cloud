import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-resize-separator-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ResizeSeparator } = await import("./ResizeSeparator");

test("renders a named focusable separator with orientation, limits and controlled region", () => {
  for (const orientation of ["vertical", "horizontal"] as const) {
    const html = renderToString(() =>
      createComponent(ResizeSeparator, {
        label: "Resize inspector",
        orientation,
        min: 20,
        max: 36,
        value: 24.125,
        controls: "inspector",
        class: "custom",
        grow: "start",
        onResize: () => {},
      }),
    );
    for (const attr of [
      'role="separator"',
      'tabindex="0"',
      'class="k2b-resize-separator custom"',
      `aria-orientation="${orientation}"`,
      `data-orientation="${orientation}"`,
      'aria-valuemin="20"',
      'aria-valuemax="36"',
      'aria-valuenow="24.13"',
      'aria-label="Resize inspector"',
      'aria-controls="inspector"',
      '<span aria-hidden="true">',
    ])
      expect(html).toContain(attr);
  }
});
