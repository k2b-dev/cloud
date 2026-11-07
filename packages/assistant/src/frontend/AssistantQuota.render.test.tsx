import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiChatQuotaBalance, AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "assistant-quota-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ Chat, LocaleProvider }, { createAssistantQuotaSections, quotaState }] = await Promise.all([
  import("@k2b/ui"),
  import("./AssistantQuota"),
]);

// A fixed clock keeps the reset time and its relative wording identical on every run.
const now = new Date("2026-01-15T10:00:00.000Z");
beforeAll(() => setSystemTime(now));
afterAll(() => setSystemTime());
const resetsAt = new Date(now.getTime() + 5 * 3_600_000 + 60_000).toISOString();
const finite = (scope: string, usedPercent: number | null): AiChatQuotaBalance => ({ scope, unlimited: false, usedPercent, resetsAt });
const unlimited = (scope: string): AiChatQuotaBalance => ({ scope, unlimited: true, usedPercent: null, resetsAt: null });
/** The budget as the composer shows it: one part of the usage control, here without a chat context yet. */
const render = (snapshot: AiChatQuotaSnapshot | null | undefined, error?: Error, locale = "de", context = false) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        const sections = createAssistantQuotaSections({
          quota: { data: () => snapshot, error: () => error, loading: () => false, refreshing: () => false, refresh: () => {} },
          model: () => "a",
          modelLabel: () => "Model A",
        });
        return sections().length
          ? createComponent(Chat.ContextUsage, {
              context,
              usage: { input: 18_000, output: 2_000 },
              contextWindow: 100_000,
              get sections() {
                return sections();
              },
            })
          : "";
      },
    }),
  );
// German percentages carry a no-break space, written as an escape below.
const trigger = (html: string) => html.slice(html.indexOf("<button"), html.indexOf("</button>"));
const budget = (html: string) => html.slice(html.indexOf('data-section="budget"'));

test("while the reading loads, the budget part keeps its place and says so", () => {
  for (const html of [render(undefined), render(null)]) {
    expect(trigger(html)).toContain('aria-label="Verbrauch: Budget Nicht verfügbar"');
    expect(trigger(html)).toContain('stroke-dasharray="0 100"');
    expect(budget(html)).toContain("<h4>Dein Budget</h4>");
    expect(budget(html)).toContain("Verbrauch wird geladen …");
  }
});

test("disabled limits and models without an allowance add no part", () => {
  expect(render({ enabled: false, balances: [finite("*", 20)] })).toBe("");
  expect(render({ enabled: true, balances: [finite("b", 20)] })).toBe("");
});

test("normal usage is a quiet grey ring without a number, with range, reset time and refresh in the details", () => {
  const html = render({ enabled: true, balances: [finite("a", 35)] });
  expect(trigger(html)).toContain('aria-label="Verbrauch: Budget 35 % genutzt"');
  expect(trigger(html)).toContain('stroke-dasharray="35 100"');
  expect(trigger(html)).not.toContain('data-warning="true"');
  expect(trigger(html)).not.toContain("k2b-chat-usage__number");
  expect(trigger(html)).not.toContain("k2b-progress-ring__mark");
  expect(budget(html)).toContain("35 % genutzt</span>");
  expect(budget(html)).toContain("Model A");
  expect(budget(html)).toContain("setzt sich in 5 Stunden zurück");
  expect(budget(html)).toContain(`datetime="${resetsAt}"`);
  expect(budget(html)).toContain('aria-label="Aktualisieren"');
  expect(budget(html)).not.toContain("Alle Modelle");
});

test("from 80 % the budget warns with the number and a mark, not by colour alone", () => {
  const near = render({ enabled: true, balances: [finite("*", 86)] });
  expect(trigger(near)).toContain('aria-label="Verbrauch: Budget 86 % genutzt, fast aufgebraucht"');
  expect(trigger(near)).toContain('data-warning="true"');
  expect(trigger(near)).toContain('<circle class="k2b-progress-ring__mark"');
  expect(trigger(near)).toContain("86 %</span>");
  expect(budget(near)).toContain('data-warning="true">86 % genutzt');

  const below = render({ enabled: true, balances: [finite("*", 79)] });
  expect(trigger(below)).not.toContain('data-warning="true"');

  const exhausted = render({ enabled: true, balances: [finite("*", 100)] });
  expect(trigger(exhausted)).toContain('aria-label="Verbrauch: Budget 100 % genutzt, aufgebraucht"');
});

test("the ring shows the higher share of context and budget", () => {
  // Context 20 %, budget 34 %: the ring follows the budget, and the label names both.
  const html = render({ enabled: true, balances: [finite("*", 34)] }, undefined, "de", true);
  expect(trigger(html)).toContain('aria-label="Verbrauch: Kontext 20 % voll, Budget 34 % genutzt"');
  expect(trigger(html)).toContain('stroke-dasharray="34 100"');
  expect(html).toContain("<h4>Dieser Chat</h4>");
  expect(html.indexOf("Dieser Chat")).toBeLessThan(html.indexOf("Dein Budget"));
  const context = render({ enabled: true, balances: [finite("*", 5)] }, undefined, "de", true);
  expect(trigger(context)).toContain('stroke-dasharray="20 100"');
});

test("unlimited usage says so instead of a share", () => {
  const snapshot = { enabled: true, balances: [unlimited("*"), unlimited("a")] };
  expect(quotaState(snapshot, "a")).toMatchObject({ unlimited: true, usedPercent: null, unknown: false });
  const html = render(snapshot);
  expect(trigger(html)).toContain('aria-label="Verbrauch: Budget Unbegrenzt"');
  expect(budget(html)).not.toContain('role="progressbar"');
  expect(budget(html)).not.toContain("zurück");
  // A model without a price is unlimited even under a finite allowance.
  const free = render({ enabled: true, unlimitedModels: ["a"], balances: [finite("*", 60)] });
  expect(trigger(free)).toContain("Budget Unbegrenzt");
});

test("several allowances are named and the fullest one decides the ring", () => {
  const snapshot = { enabled: true, balances: [finite("*", 70), finite("a", 20), finite("b", 99)] };
  expect(quotaState(snapshot, "a").usedPercent).toBe(70);
  const html = render(snapshot);
  expect(trigger(html)).toContain("Budget 70 % genutzt");
  expect(budget(html)).toContain("Alle Modelle · 70 %");
  expect(budget(html)).toContain("Model A · 20 %");
  // The other model's allowance appears neither as a share nor as a bar, and does not drive the ring.
  expect(html).not.toContain("99 %");
  expect(html).not.toContain('aria-valuenow="99"');
  expect(trigger(html)).toContain('stroke-dasharray="70 100"');
  expect(budget(html).match(/role="progressbar"/g)).toHaveLength(2);
  expect(budget(html).match(/setzt sich in 5 Stunden zurück/g)).toHaveLength(2);
  // One refresh for the part, at the end of its last line.
  expect(budget(html).match(/aria-label="Aktualisieren"/g)).toHaveLength(1);
});

test("usage that cannot be measured is not shown as a share", () => {
  const html = render({ enabled: true, balances: [finite("*", null)] });
  expect(trigger(html)).toContain('aria-label="Verbrauch: Budget Nicht verfügbar"');
  expect(budget(html)).not.toContain('role="progressbar"');
});

test("a failed reading never presents a cached share as current and offers a retry", () => {
  for (const snapshot of [{ enabled: true, balances: [finite("*", 20)] }, null]) {
    const html = render(snapshot, new Error("offline"));
    expect(trigger(html)).toContain('aria-label="Verbrauch: Budget Nicht verfügbar"');
    expect(trigger(html)).toContain('stroke-dasharray="0 100"');
    expect(budget(html)).toContain("Verbrauch nicht verfügbar");
    expect(budget(html)).toContain("Erneut versuchen");
    expect(html).not.toContain("20 %");
  }
});

test("users never see money or costs, in either language", () => {
  const snapshot = { enabled: true, balances: [finite("*", 70), finite("a", 100), unlimited("b")] };
  for (const locale of ["de", "en"]) {
    const html = render(snapshot, undefined, locale);
    expect(html).not.toMatch(/EUR|€|\$|kosten|cost|preis|price|kontingent|allowance/i);
  }
  expect(render(snapshot, undefined, "en")).toContain('aria-label="Usage: budget 100% used, used up"');
  expect(render({ enabled: true, balances: [finite("*", 35)] }, undefined, "en")).toContain("resets in 5 hours");
});
