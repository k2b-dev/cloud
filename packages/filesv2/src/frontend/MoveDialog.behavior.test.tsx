import { expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { BaseSummary } from "../contracts";

const base: BaseSummary = {
  id: "freeipa:users:alice",
  area: "freeipa",
  kind: "users",
  name: "Alice",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: true,
  managed: false,
  executionEnabled: true,
  stableIds: false,
};

if (!isServer) {
  for (const mode of [403, 404, 503, "unknown", "readonly", "pending"] as const) {
    test(`destination ${mode} preview preserves the appropriate confirm state`, async () => {
      const dom = createDomTestHarness();
      const originalFetch = globalThis.fetch;
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL) => {
          if (!String(input).includes("destination-previews")) return Response.json({ items: [], next: null });
          if (mode === "pending") await hold;
          return typeof mode === "number"
            ? Response.json({ code: "forbidden" }, { status: mode })
            : Response.json([
                {
                  baseId: base.id,
                  folder: "target",
                  canWrite: mode === "readonly" ? false : null,
                  sourceCount: 1,
                  sourceMovableCount: 1,
                  copy: false,
                  copyReason: null,
                  versioningEnabled: false,
                  access: null,
                },
              ]);
        },
        { preconnect: originalFetch.preconnect },
      );
      const prototype = dom.window.HTMLElement.prototype;
      const show = Object.getOwnPropertyDescriptor(prototype, "showPopover");
      const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
      Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
      Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
      const { DestinationPicker } = await import("./MoveDialog");
      delegateEvents(["click"]);
      const choices: unknown[] = [];
      const dispose = render(
        () => (
          <DestinationPicker
            bases={[base]}
            sourceBaseId={base.id}
            sourcePaths={["item.txt"]}
            initialFolder="target"
            close={(value) => choices.push(value)}
          />
        ),
        dom.root,
      );
      try {
        for (let i = 0; i < 20; i++) await Bun.sleep(5);
        const confirm = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Move here"),
        )!;
        expect(confirm).toBeDefined();
        dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!.click();
        await Bun.sleep(0);
        if (mode === "pending") {
          expect(confirm.disabled).toBe(true);
          expect(dom.root.textContent).toContain("Checking destination details…");
          expect(dom.root.textContent).not.toContain("could not be checked");
          release();
          for (let i = 0; i < 20; i++) await Bun.sleep(5);
        }
        expect(confirm.disabled).toBe(mode === "readonly");
        const row = dom.root.querySelector<HTMLElement>('[role="option"]')!;
        expect(row.getAttribute("aria-disabled") === "true").toBe(mode === "readonly");
        if (typeof mode === "number") {
          expect(dom.root.textContent).toContain("Destination details could not be checked.");
          expect([...dom.root.querySelectorAll("button")].some((button) => button.textContent?.includes("Try again"))).toBe(true);
        }
        if (mode !== "readonly") {
          confirm.click();
          expect(choices).toEqual([{ baseId: base.id, folder: "target", copy: false }]);
          expect(dom.root.textContent).not.toContain("No version history here.");
        }
      } finally {
        release();
        dispose();
        globalThis.fetch = originalFetch;
        if (show) Object.defineProperty(prototype, "showPopover", show);
        else Reflect.deleteProperty(prototype, "showPopover");
        if (hide) Object.defineProperty(prototype, "hidePopover", hide);
        else Reflect.deleteProperty(prototype, "hidePopover");
        dom.cleanup();
      }
    }, 30_000);
  }
}
