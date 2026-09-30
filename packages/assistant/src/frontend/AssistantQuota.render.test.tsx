import { expect, test } from "bun:test";
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
const [{ LocaleProvider }, { default: Quota, quotaState }] = await Promise.all([import("@k2b/ui"), import("./AssistantQuota")]);

const resetsAt = new Date(Date.now() + 5 * 3_600_000 + 60_000).toISOString();
const finite = (scope: string, usedPercent: number | null): AiChatQuotaBalance => ({ scope, unlimited: false, usedPercent, resetsAt });
const unlimited = (scope: string): AiChatQuotaBalance => ({ scope, unlimited: true, usedPercent: null, resetsAt: null });
const render = (snapshot: AiChatQuotaSnapshot | null | undefined, error?: Error, locale = "de") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Quota, { snapshot, model: "a", modelLabel: "Model A", error, onRefresh: () => {} });
      },
    }),
  );
// German percentages carry a no-break space, written as an escape below.
const trigger = (html: string) => html.slice(html.indexOf("<button"), html.indexOf("</button>"));

test("loading reserves the indicator box without a control or a value", () => {
  for (const html of [render(undefined), render(null), render(null, new Error("offline"))]) {
    expect(html).toContain('<span class="k2b-chat-context" data-usage="loading" aria-hidden="true">');
    expect(html).toContain("ti ti-circle-dashed");
    expect(html).not.toContain("k2b-progress-ring");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('role="dialog"');
  }
});

test("disabled limits and models without an allowance show nothing", () => {
  expect(render({ enabled: false, balances: [finite("*", 20)] })).toBe("");
  expect(render({ enabled: true, balances: [finite("b", 20)] })).toBe("");
});

test("normal usage is a quiet ring with a name and value but no number on it", () => {
  const html = render({ enabled: true, balances: [finite("*", 35)] });
  expect(html).toContain('aria-label="Nutzung: 35\u00a0%"');
  expect(html).toContain('data-usage="info"');
  expect(trigger(html)).toContain('stroke-dasharray="35 100"');
  // No text node inside the trigger: every tag is followed directly by another tag.
  expect(trigger(html)).not.toMatch(/>[^<]/);
  expect(trigger(html)).not.toContain("k2b-progress-ring__mark");
  // One allowance needs no name; the panel says what was used and when it resets.
  expect(html).toContain("<strong>Nutzung</strong>");
  expect(html).toContain("<dt>Verbraucht</dt>");
  expect(html).toContain("35\u00a0%</dd>");
  expect(html).toContain("Setzt sich in 5 Stunden zurück");
  expect(html).toContain(`datetime="${resetsAt}"`);
  expect(html).not.toContain("Alle Modelle");
  expect(html.match(/<button/g)).toHaveLength(1);
});

test("near the limit and used up differ by label and mark, not by colour alone", () => {
  const near = render({ enabled: true, balances: [finite("*", 92)] });
  expect(near).toContain('aria-label="Nutzung: 92\u00a0%, fast aufgebraucht"');
  expect(near).toContain('data-usage="warning"');
  expect(trigger(near)).toContain('data-tone="warning"');
  expect(trigger(near)).toContain('<circle class="k2b-progress-ring__mark"');

  const exhausted = render({ enabled: true, balances: [finite("*", 100)] });
  expect(exhausted).toContain('aria-label="Nutzung: 100\u00a0%, aufgebraucht"');
  expect(exhausted).toContain('data-usage="danger"');
  expect(trigger(exhausted)).toContain('data-tone="danger"');
  expect(trigger(exhausted)).toContain('<path class="k2b-progress-ring__mark"');
});

test("unlimited usage shows an infinity icon instead of a ring", () => {
  const snapshot = { enabled: true, balances: [unlimited("*"), unlimited("a")] };
  expect(quotaState(snapshot, "a")).toMatchObject({ unlimited: true, usedPercent: null, unknown: false });
  const html = render(snapshot);
  expect(html).toContain('aria-label="Nutzung: Unbegrenzt"');
  expect(trigger(html)).toContain("ti ti-infinity");
  expect(html).not.toContain("k2b-progress-ring");
  expect(html).not.toContain('role="progressbar"');
  expect(html).not.toContain("zurück");
  // A model without a price is unlimited even under a finite allowance.
  const free = render({ enabled: true, unlimitedModels: ["a"], balances: [finite("*", 60)] });
  expect(trigger(free)).toContain("ti ti-infinity");
});

test("several allowances are named and the fullest one decides the ring", () => {
  const snapshot = { enabled: true, balances: [finite("*", 70), finite("a", 20), finite("b", 99)] };
  expect(quotaState(snapshot, "a").usedPercent).toBe(70);
  const html = render(snapshot);
  expect(html).toContain('aria-label="Nutzung: 70\u00a0%"');
  expect(html).toContain("<dt>Alle Modelle</dt>");
  expect(html).toContain("<dt>Model A</dt>");
  expect(html).toContain("70\u00a0%</dd>");
  expect(html).toContain("20\u00a0%</dd>");
  expect(html).not.toContain("99");
  expect(html.match(/role="progressbar"/g)).toHaveLength(2);
  expect(html.match(/Setzt sich in 5 Stunden zurück/g)).toHaveLength(2);
});

test("usage that cannot be measured is not shown as a share", () => {
  const html = render({ enabled: true, balances: [finite("*", null)] });
  expect(html).toContain('aria-label="Nutzung: Nicht verfügbar"');
  expect(html).toContain('data-usage="unknown"');
  expect(html).not.toContain('role="progressbar"');
});

test("a failed refresh never presents a cached share as current", () => {
  const html = render({ enabled: true, balances: [finite("*", 20)] }, new Error("offline"));
  expect(html).toContain('aria-label="Nutzung: Nicht verfügbar"');
  expect(html).toContain('data-usage="unavailable"');
  expect(html).toContain("Die Nutzung konnte nicht geladen werden.");
  expect(html).not.toContain("20\u00a0%");
  // The trigger shows a dashed circle, never the empty ring of a real 0 %, and not the last known state either.
  const face = (markup: string) => trigger(markup).replace(/^<button[^>]*>/, "");
  const zero = face(render({ enabled: true, balances: [finite("*", 0)] }));
  expect(zero).toContain('stroke-dasharray="0 100"');
  expect(face(html)).toContain("ti ti-circle-dashed");
  expect(face(html)).not.toContain("k2b-progress-ring");
  expect(face(html)).not.toBe(zero);
  expect(face(render({ enabled: true, balances: [unlimited("*")] }, new Error("offline")))).toBe(face(html));
});

test("users never see money, costs, or a refresh control, in either language", () => {
  const snapshot = { enabled: true, balances: [finite("*", 70), finite("a", 100), unlimited("b")] };
  for (const locale of ["de", "en"]) {
    const html = render(snapshot, undefined, locale);
    expect(html).not.toMatch(/EUR|€|\$|kosten|cost|preis|price|kontingent|allowance|aktualisieren|refresh/i);
    expect(html.match(/<button/g)).toHaveLength(1);
  }
  expect(render(snapshot, undefined, "en")).toContain('aria-label="Usage: 100%, used up"');
  expect(render({ enabled: true, balances: [finite("*", 35)] }, undefined, "en")).toContain("Resets in 5 hours");
});
