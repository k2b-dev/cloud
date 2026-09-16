import { expect, test, spyOn } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { quotaFixture } from "./ai-quota-fixture";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
if (isServer) test.skip("requires browser conditions", () => {});
else
  test("account details load on eye click without changing the URL", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./AiQuotaAdmin.island.tsx");
    const { dialogCore, LocaleProvider } = await import("@k2b/ui");
    const initial = quotaFixture({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "user",
          label: "Anna",
          lastUsed: null,
          cost: 90,
          input: 80,
          output: 10,
          calls: 1,
          measured: 1,
          estimated: 0,
          unknown: 0,
          status: "available",
          scopes: 1,
          exhausted: 0,
          balances: [{ scope: "*", limit: 100, used: 90, unknown: 0, bypassed: false }],
        },
      ],
      total: 1,
    });
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
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(Panel, { config: { enabled: true, revision: 0, rules: [] }, models: [], report: initial });
          },
        }),
      dom.root,
    );
    try {
      await tick();
      expect(fetch).not.toHaveBeenCalled();
      expect(dom.root.textContent).toContain("90 / 100");
      const before = dom.window.location.href;
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Details: Anna"]')!.click();
      await tick();
      expect(dialogCore.isOpen()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(dom.window.location.href).toBe(before);
      resolve?.(Response.json({ enabled: true, usage: [], balances: [] }));
      await tick();
      expect(dom.document.body.textContent).toContain("Keine Quotenregeln");
      dialogCore.close();
      expect(dom.root.textContent).toContain("Anna");
    } finally {
      dialogCore.close();
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
      () => createComponent(Panel, { config: { enabled: false, revision: 0, rules: [] }, models: [], report }),
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
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ used: 0, reserved: 0, unknown: 0, stoppedAt: null, unit: "EUR" }), {
        preconnect: globalThis.fetch.preconnect,
      }),
    );
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
      expect(dom.document.querySelector<HTMLInputElement>('input[role="spinbutton"]')?.value).toBe("24");
      click(dom.document, "Apply to draft");
      expect(dialogCore.isOpen()).toBe(false);
      expect(dom.root.textContent).toContain("Unsaved changes");
      expect(dom.root.textContent).toContain("All chat models");
      expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    } finally {
      dialogCore.close();
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
if (!isServer)
  test("reset refreshes the open modal and preserves typed grant explanations", async () => {
    const dom = createDomTestHarness();
    const { default: Detail } = await import("./AiQuotaDetail");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    let resets = 0,
      changed = 0,
      saving = false;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: unknown, init?: RequestInit) => {
          if (init?.method === "POST") {
            resets++;
            return Response.json({ ok: true });
          }
          return Response.json({
            enabled: true,
            usage: [],
            balances: [
              {
                scope: "*",
                limit: 100,
                used: resets ? 0 : 90,
                input: resets ? 0 : 80,
                output: resets ? 0 : 10,
                unknown: 0,
                bypassed: false,
                resetsAt: "2026-09-21T00:00:00Z",
                sources: ["Authenticated users"],
                sourceDetails: [{ principal: { type: "authenticated" }, displayName: "Authenticated users" }],
              },
            ],
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () =>
        createComponent(Detail, {
          unit: "EUR",
          who: { id: "11111111-1111-4111-8111-111111111111", type: "user", label: "Anna", lastUsed: null },
          modelName: () => "All chat models",
          range: "30d",
          close: () => {},
          changed: () => {
            changed++;
          },
          saving: (value) => {
            saving = value;
          },
        }),
      dom.root,
    );
    try {
      await tick();
      expect(dom.root.textContent).toContain("90 / 100");
      expect(dom.root.textContent).toContain("This limit applies through");
      expect(dom.root.textContent).toContain("All signed-in users");
      expect(dom.root.textContent).not.toContain("Authenticated users");
      Array.from(dom.root.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("Reset allowance"))!
        .click();
      await tick();
      await tick();
      expect(resets).toBe(1);
      expect(changed).toBe(1);
      expect(saving).toBe(false);
      expect(dom.root.textContent).toContain("0 / 100");
    } finally {
      dispose();
      fetch.mockRestore();
      confirm.mockRestore();
      dom.cleanup();
    }
  });
