import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { aiFixtureCatalog } from "./AiArea.fixture-data";

const root = mkdtempSync(join(tmpdir(), "core-ai-model-price-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
const { default: ModelDetail } = await import("./ModelDetail");
beforeAll(() => setSystemTime(new Date("2026-11-19T09:00:00.000Z")));
afterAll(() => setSystemTime());

for (const locale of ["de", "en"]) {
  for (const scenario of [
    { kind: "chat", pricing: null, hint: true, contextWindow: null, maxOutputTokens: null, limitsHint: false },
    {
      kind: "chat",
      pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      hint: true,
      contextWindow: null,
      maxOutputTokens: null,
      limitsHint: false,
    },
    {
      kind: "chat",
      pricing: { inputPerMillion: 0, outputPerMillion: 1 },
      hint: false,
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      limitsHint: false,
    },
    {
      kind: "chat",
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
      hint: false,
      contextWindow: null,
      maxOutputTokens: 4096,
      limitsHint: true,
    },
    {
      kind: "chat",
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
      hint: false,
      contextWindow: 128_000,
      maxOutputTokens: null,
      limitsHint: true,
    },
    { kind: "transcription", pricing: null, hint: false, contextWindow: null, maxOutputTokens: null, limitsHint: false },
    { kind: "decision", pricing: null, hint: false, contextWindow: 128_000, maxOutputTokens: null, limitsHint: false },
  ] as const) {
    test(`${locale}: ${scenario.kind} with prices ${JSON.stringify(scenario.pricing)} explains automation eligibility`, () => {
      const catalog = aiFixtureCatalog();
      const provider = catalog.providers[0]!;
      const model = {
        ...catalog.models[0]!,
        kind: scenario.kind,
        pricing: scenario.pricing,
        contextWindow: scenario.contextWindow,
        maxOutputTokens: scenario.maxOutputTokens,
        outputTokenLimit: null,
        variants: [],
      };
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(ModelDetail, {
              provider: { ...provider, models: [model] },
              model,
              usage: null,
              slots: [],
              assignments: {},
              accountingUnit: "EUR",
              back: { label: provider.label, href: "/admin/ai?sec=providers&p=cortecs" },
              onVariant: () => {},
              onDelete: () => {},
            });
          },
        }),
      );
      const hint =
        locale === "de"
          ? "Ohne einen Preis über 0 können Automationen mit diesem Modell keinen Gustav-Zug starten."
          : "Without a price above zero, automations cannot start a Gustav turn with this model.";
      expect(html.includes(hint)).toBe(scenario.hint);
      // the hint is a quiet note of its own (a v2 Notice), not a warning
      if (scenario.hint) expect(html).toMatch(new RegExp(`data-k2-part="Notice" data-tone="note"[^]*?${hint}`));
      expect(
        html.includes(
          locale === "de" ? "Trage vor dem Speichern die dokumentierten Grenzen" : "Enter the limits documented by the provider",
        ),
      ).toBe(scenario.limitsHint);
    });
  }
}
