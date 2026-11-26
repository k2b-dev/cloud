import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "pwa-start-summary-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: StartParts } = await import("./StartParts");

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
  // each part is a row that leads to it; a part with a live summary keeps a blank second line until it answers
  const rows = html.split('data-k2-part="Row"').slice(1);
  const row = (href: string) => rows.find((candidate) => candidate.includes(`href="${href}"`)) ?? "";
  expect(html).not.toContain("Count the shelves");
  expect(row("/pwa/inventory")).toContain("Inventory");
  expect(row("/pwa/inventory")).toContain("\u00a0");
  expect(row("/pwa/notes")).toContain("Your notes");
});
