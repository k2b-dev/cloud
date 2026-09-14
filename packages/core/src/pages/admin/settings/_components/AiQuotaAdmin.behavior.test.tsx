import { expect, test, spyOn } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
if (isServer) test.skip("requires browser conditions", () => {});
else
  test("switching users never shows a reset for the previous identity", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./AiQuotaAdmin.island.tsx");
    const a = "11111111-1111-4111-8111-111111111111",
      b = "22222222-2222-4222-8222-222222222222";
    let resolveB: ((value: Response) => void) | undefined;
    const balance = {
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
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input instanceof Request ? input.url : input);
          if (url.includes("/users"))
            return Response.json({
              items: [
                { id: a, type: "user", label: "Anna", lastUsed: null },
                { id: b, type: "user", label: "Ben", lastUsed: null },
              ],
              total: 2,
              page: 1,
              perPage: 25,
            });
          if (url.includes("/balance") && url.includes(b))
            return new Promise<Response>((r) => {
              resolveB = r;
            });
          return Response.json(balance);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(Panel, { config: { enabled: false, revision: 0, rules: [] }, models: [] }), dom.root);
    const click = (text: string) => {
      const el = Array.from(dom.root.querySelectorAll("button")).find((b) => b.textContent === text);
      expect(el).toBeDefined();
      el!.click();
    };
    try {
      await tick();
      click("Users");
      await tick();
      click("Anna");
      await tick();
      expect(dom.root.textContent).toContain("90 / 100");
      click("Ben");
      await tick();
      expect(dom.root.textContent).not.toContain("90 / 100");
      expect(Array.from(dom.root.querySelectorAll("button")).some((b) => b.textContent === "Reset allowance")).toBe(false);
      resolveB?.(Response.json({ ...balance, balances: [] }));
      await tick();
      expect(dom.root.textContent).toContain("Ben");
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
