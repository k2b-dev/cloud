import { expect, test, spyOn } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { quotaFixture } from "./ai-quota-fixture";
import type { AiQuotaReport } from "@k2b/cloud/shared";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
if (isServer) test.skip("requires browser conditions", () => {});
else
  test("SSR report avoids refetch and changing identity hides the previous allowance", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./AiQuotaAdmin.island.tsx");
    const a = "11111111-1111-4111-8111-111111111111",
      b = "22222222-2222-4222-8222-222222222222";
    const initial = quotaFixture();
    initial.selected = { id: a, type: "user", label: "Anna", lastUsed: null };
    initial.query.identity = a;
    const snapshot = {
      enabled: true,
      usage: [],
      balances: [
        {
          scope: "*",
          limit: 100,
          input: 80,
          output: 10,
          used: 90,
          unknown: 0,
          resetsAt: "2026-09-21T00:00:00Z",
          sources: ["Team"],
          bypassed: false,
        },
      ],
    };
    let resolve: ((r: Response) => void) | undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const [report, setReport] = createSignal<AiQuotaReport>(initial);
    const dispose = render(
      () =>
        createComponent(Panel, {
          config: { enabled: true, revision: 0, rules: [] },
          models: [],
          get report() {
            return report();
          },
          balance: snapshot,
        }),
      dom.root,
    );
    try {
      await tick();
      expect(fetch).not.toHaveBeenCalled();
      expect(dom.root.textContent).toContain("90 / 100");
      setReport({ ...initial, query: { ...initial.query, identity: b }, selected: { id: b, type: "user", label: "Ben", lastUsed: null } });
      await tick();
      expect(dom.root.textContent).not.toContain("90 / 100");
      expect(dom.root.textContent).not.toContain("Reset allowance");
      resolve?.(Response.json({ ...snapshot, balances: [] }));
      await tick();
      expect(dom.root.textContent).toContain("No quota rules");
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
if (!isServer)
  test("pagination uses server-clamped page and retains report filters", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./AiQuotaAdmin.island.tsx");
    const report = quotaFixture({ total: 51, page: 2 });
    report.query = { ...report.query, page: 2, search: "Anna", model: "a" };
    const dispose = render(
      () => createComponent(Panel, { config: { enabled: false, revision: 0, rules: [] }, models: [], report, balance: null }),
      dom.root,
    );
    try {
      const links = Array.from(dom.root.querySelectorAll("a[href]"));
      const next = links.find((a) => a.getAttribute("href")?.includes("page=3"));
      expect(next).toBeDefined();
      expect(next!.getAttribute("href")).toContain("search=Anna");
      expect(next!.getAttribute("href")).toContain("model=a");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
if (!isServer)
  test("rule dialog cancellation leaves the config unchanged and applying only edits the draft", async () => {
    const dom = createDomTestHarness();
    const { default: Rules } = await import("./AiQuotaRules");
    const { dialogCore } = await import("@k2b/ui");
    const fetch = spyOn(globalThis, "fetch");
    const dispose = render(() => createComponent(Rules, { config: { enabled: false, revision: 0, rules: [] }, models: [] }), dom.root);
    const click = (root: ParentNode, label: string) => {
      const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    };
    try {
      click(dom.root, "Add rule");
      expect(dialogCore.isOpen()).toBe(true);
      click(dom.document, "Cancel");
      expect(dom.root.textContent).not.toContain("Unsaved changes");
      click(dom.root, "Add rule");
      click(dom.document, "Apply to draft");
      expect(dialogCore.isOpen()).toBe(false);
      expect(dom.root.textContent).toContain("Unsaved changes");
      expect(dom.root.textContent).toContain("All chat models");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
