import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "assistant-quota-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: Quota, quotaState }] = await Promise.all([import("@k2b/ui"), import("./AssistantQuota")]);
const balance = (scope: string, limit: number | null, used = 20, bypassed = false) => ({
  scope,
  limit,
  used,
  input: used,
  output: 0,
  unknown: 0,
  resetsAt: "2026-10-01T00:00:00Z",
  bypassed,
});
const render = (snapshot: AiChatQuotaSnapshot | undefined, error?: Error) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(Quota, { snapshot, model: "a", modelLabel: "Model A", error, onRefresh: () => {} });
      },
    }),
  );
test("disabled and unconfigured models have no quota controls", () => {
  expect(render({ enabled: false, balances: [balance("*", 100)] })).toBe("");
  expect(render({ enabled: true, balances: [balance("b", 100)] })).toBe("");
});
test("tightest applicable remaining quota wins and wrong model is absent", () => {
  const snapshot = { enabled: true, balances: [balance("*", 100, 70), balance("a", 100, 20), balance("b", 100, 99)] };
  expect(quotaState(snapshot, "a").remaining).toBeCloseTo(30);
  const html = render(snapshot);
  expect(html).toContain("30 % frei");
  expect(html).toContain("Alle Chatmodelle");
  expect(html).toContain("Model A");
  expect(html).toContain('role="dialog"');
  expect(html).toContain('role="progressbar"');
});
test("global unlimited bypasses finite and unknown model quota", () => {
  const snapshot = { enabled: true, balances: [balance("*", null), { ...balance("a", 0, 100, true), unknown: 1 }] };
  expect(quotaState(snapshot, "a")).toMatchObject({ remaining: null, unknown: false });
  expect(render(snapshot)).toContain("Unbegrenzt");
  expect(render(snapshot)).not.toContain('role="progressbar"');
});
test("errors never present cached allowance as fresh", () => {
  const html = render({ enabled: true, balances: [balance("*", 100, 20)] }, new Error("offline"));
  expect(html).toContain("Nicht verfügbar");
  expect(html).not.toContain("80 % frei");
  expect(html).toContain("Aktualisieren");
});
test("missing usage differs from exhausted quota", () => {
  expect(render({ enabled: true, balances: [{ ...balance("*", 100), unknown: 1 }] })).toContain("Nutzung prüfen");
  expect(render({ enabled: true, balances: [balance("*", 0)] })).toContain("Dein Entwurf bleibt erhalten");
});

test("failed discovery never invents an enabled quota UI", () => {
  expect(render(undefined, new Error("offline"))).not.toContain("Nicht verfügbar");
  expect(render({ enabled: false, balances: [] }, new Error("offline"))).not.toContain("Nicht verfügbar");
});
