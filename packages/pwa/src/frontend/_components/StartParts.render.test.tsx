import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "pwa-start-summary-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: StartParts } = await import("./StartParts.island");

test("Start SSR reserves the same summary line as the first browser render", () => {
  const html = renderToString(() =>
    createComponent(StartParts, {
      label: "Apps",
      endpoints: ["/api/inventory/summary"],
      parts: [
        {
          id: "inventory",
          label: "Inventory",
          icon: "ti ti-box",
          href: "/pwa/inventory",
          description: "Count the shelves",
          summary: "/api/inventory/summary",
        },
        { id: "notes", label: "Notes", icon: "ti ti-notes", href: "/pwa/notes", description: "Your notes" },
      ],
    }),
  );
  expect(html).not.toContain("Count the shelves");
  expect(html).toContain("<small>\u00a0</small>");
  expect(html).toContain("<small>Your notes</small>");
});
