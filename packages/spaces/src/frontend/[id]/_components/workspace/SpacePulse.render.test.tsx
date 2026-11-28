import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "spaces-pulse-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacePulse } = await import("./SpacePulse");
const { LocaleProvider } = await import("@k2b/ui");

const pulse = { done: Array(14).fill(1), overdue: 0, unassigned: 2 };
const render = (description: string | null, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SpacePulse, { pulse, color: "#6366f1", description });
      },
    }),
  );

describe("the Space pulse", () => {
  test("names the Space's description once, as a line of the band that opens to the whole text", () => {
    const html = render("Shelves, routes and the weekly stock count of the north warehouse.");
    expect(html.match(/data-k2-part="Disclosure"/g)).toHaveLength(1);
    expect(html).toContain("About this Space");
    expect(render("Lager und Routen", "de")).toContain("Über diesen Space");
  });

  test("shows no line and keeps no room when the Space has no description", () => {
    for (const description of [null, "", "   "]) {
      const html = render(description);
      expect(html).not.toContain('data-k2-part="Disclosure"');
      expect(html).not.toContain("About this Space");
    }
  });
});
