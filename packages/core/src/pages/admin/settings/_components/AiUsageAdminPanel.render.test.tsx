import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { usageFixture } from "./ai-usage-fixture";
const root = mkdtempSync(join(tmpdir(), "core-ai-usage-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: Panel }] = await Promise.all([import("@k2b/ui"), import("./AiUsageExplorer.island.tsx")]);
describe("AI usage explorer rendering", () => {
  for (const locale of ["en", "de"]) {
    test(`renders URL-backed filters and comparisons in ${locale}`, () => {
      const report = usageFixture();
      report.query.view = "comparisons";
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Panel, { report });
          },
        }),
      );
      expect(html).not.toContain(locale === "de" ? "Filter anwenden" : "Apply filters");
      expect(html).toContain("k2b-filter-chip");
      expect(html).toContain("Ada");
      expect(html).not.toContain("provider/model-a");
      expect(html).not.toContain(locale === "de" ? "Weitere Filter" : "More filters");
      expect(html).toContain("userId=11111111-1111-4111-8111-111111111111");
      expect(html).toContain("rating=down");
      expect(html).toContain("status=failed");
      expect(html).toContain(locale === "de" ? "Bewertungsabdeckung" : "Response rating coverage");
    });
  }
  test("makes failed runs inspectable and keeps missing usage distinct from zero", () => {
    const report = usageFixture();
    report.query.view = "runs";
    const html = renderToString(() => createComponent(Panel, { report }));
    expect(html).toContain("Show error");
    expect(html).toContain("A complete error");
    expect(html).toContain("Unassigned");
  });
});
