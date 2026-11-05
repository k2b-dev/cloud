import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { aiFixtureCatalog, aiFixtureOverview } from "./AiArea.fixture-data";
import { parseAiAreaQuery } from "./area";
import { aiAreaMessages } from "./messages";

const root = mkdtempSync(join(tmpdir(), "core-ai-decision-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { AiAreaView } = await import("./view");

test("the decision class renders on the server in both admin locales", () => {
  const catalog = aiFixtureCatalog();
  const overview = aiFixtureOverview(catalog);
  for (const locale of ["en", "de"]) {
    const t = aiAreaMessages.resolve([locale]).t;
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(AiAreaView, {
            t,
            locale,
            query: parseAiAreaQuery({ sec: "classes" }),
            overview,
            index: { models: catalog.models, variants: catalog.variants, assignments: overview.assignments },
            loadFailed: false,
            studioLinks: [],
            provider: undefined,
            providerDetail: null,
            model: null,
            usage: null,
            accountingUnit: "EUR",
            assignmentDetails: [],
            appNames: {},
            retryHref: "/admin/ai?sec=classes",
          });
        },
      }),
    );
    expect(html).toContain("slot=decision");
    expect(html).toContain(locale === "de" ? "Entscheidung" : "Decision");
    expect(t.slotd_decision).toContain(locale === "de" ? "Wahrscheinlichkeiten" : "probabilities");
  }
});
