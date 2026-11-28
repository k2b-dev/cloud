import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { aiFixtureCatalog, aiFixtureOverview } from "./AiArea.fixture-data";
import { parseAiAreaQuery } from "./area";
import { aiAreaMessages } from "./messages";

const root = mkdtempSync(join(tmpdir(), "core-ai-decision-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ClassesScreen } = await import("./ClassesScreen");
const { adminNavFixture } = await import("../admin-v2.fixture");

test("the decision class renders on the server in both admin locales", () => {
  const catalog = aiFixtureCatalog();
  const overview = aiFixtureOverview(catalog);
  for (const locale of ["en", "de"]) {
    const t = aiAreaMessages.resolve([locale]).t;
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(ClassesScreen, {
            nav: adminNavFixture("/admin/ai"),
            data: {
              overview,
              models: catalog.models,
              variants: catalog.variants,
              slot: parseAiAreaQuery({ sec: "classes" }).slot ?? null,
              assignment: null,
              detailFailed: false,
            },
            appNames: {},
          });
        },
      }),
    );
    expect(html).toContain("slot=decision");
    expect(html).toContain(locale === "de" ? "Entscheidung" : "Decision");
    expect(t.slotd_decision).toContain(locale === "de" ? "Wahrscheinlichkeiten" : "probabilities");
  }
});
