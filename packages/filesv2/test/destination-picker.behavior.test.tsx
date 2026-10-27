import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BaseSummary } from "../src/contracts";

const base: BaseSummary = {
  id: "cloud:users:alice",
  area: "cloud",
  kind: "users",
  name: "alice",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
};
const modules = isServer
  ? undefined
  : await (async () => {
      const dom = createDomTestHarness();
      try {
        return await import("../src/frontend/MoveDialog");
      } finally {
        dom.cleanup();
      }
    })();
if (!isServer)
  test("destination preview retries, disables read-only targets and keeps folder browsing and copy confirmation", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let fail = true;
    let rootReadOnly = false;
    let denied = false;
    const requested: unknown[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("destination-previews")) {
          const body = JSON.parse(String(init?.body));
          requested.push(body);
          if (denied) return Response.json({ code: "forbidden", message: "Denied" }, { status: 403 });
          if (fail) return Response.json({ code: "unavailable", message: "Unavailable" }, { status: 503 });
          return Response.json(
            body.targets.map((target: { baseId: string; folder: string }) => ({
              ...target,
              canWrite: target.folder !== "readonly" && (!rootReadOnly || target.folder !== ""),
              sourceCount: body.paths.length,
              sourceMovableCount: 0,
              copy: true,
              copyReason: "source_read_only",
              versioningEnabled: true,
              access: {
                kind: "personal",
                name: "alice",
                owner: true,
                group: false,
                additionalUsers: 0,
                additionalGroups: 0,
                others: false,
              },
            })),
          );
        }
        return Response.json({
          base,
          path: "",
          items: [
            { name: "Target", path: "target", directory: true, size: 0, modified: "2026-10-01T12:00:00Z" },
            { name: "Readonly", path: "readonly", directory: true, size: 0, modified: "2026-10-01T12:00:00Z" },
          ],
          next: null,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const prototype = dom.window.HTMLElement.prototype;
    const show = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
    const { DestinationPicker } = modules!;
    delegateEvents(["click"]);
    const results: unknown[] = [];
    const [available, setAvailable] = createSignal([base]);
    const dispose = render(
      () => (
        <DestinationPicker
          bases={available()}
          sourceBaseId={base.id}
          sourcePaths={["item.txt"]}
          initialFolder=""
          close={(result) => results.push(result)}
        />
      ),
      dom.root,
    );
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Bun.sleep(5);
    };
    const button = (label: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
    try {
      await flush();
      const trigger = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      trigger.click();
      await flush();
      expect(button("Retry")).toBeDefined();
      expect(button("Move here")?.disabled ?? button("Copy here")?.disabled).toBe(true);
      fail = false;
      button("Retry")!.click();
      await flush();
      const rows = [...dom.root.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(rows.find((row) => row.textContent?.includes("Readonly"))!.getAttribute("aria-disabled")).toBe("true");
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await flush();
      expect(dom.root.textContent).toContain("Your personal storage");
      expect(dom.root.textContent).toContain("Version history");
      expect(dom.root.textContent).toContain("the originals stay where they are");
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      dom.root.querySelector<HTMLButtonElement>(".filesv2-picker__tile")!.click();
      await flush();
      expect(requested.at(-1)).toMatchObject({
        paths: ["item.txt"],
        targets: expect.arrayContaining([{ baseId: base.id, folder: "target" }]),
      });
      button("Copy here")!.click();
      expect(results).toEqual([{ baseId: base.id, folder: "target", copy: true }]);
      rootReadOnly = true;
      button("Storage")!.click();
      await flush();
      trigger.click();
      await flush();
      expect(dom.root.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // A disabled destination still has a browsing tile, so writable descendants remain reachable.
      dom.root.querySelector<HTMLButtonElement>(".filesv2-picker__tile")!.click();
      await flush();
      expect(button("Copy here")!.disabled).toBe(true);
      dom.root.querySelector<HTMLButtonElement>(".filesv2-picker__tile")!.click();
      await flush();
      expect(button("Copy here")!.disabled).toBe(false);
      setAvailable([]);
      button("Storage")!.click();
      await flush();
      trigger.click();
      await flush();
      expect(dom.root.textContent).toContain("No destination");
      denied = true;
      setAvailable([base]);
      await flush();
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("No write access");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      if (show) Object.defineProperty(prototype, "showPopover", show);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (hide) Object.defineProperty(prototype, "hidePopover", hide);
      else Reflect.deleteProperty(prototype, "hidePopover");
      dom.cleanup();
    }
  });
