import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { WormholeTransferPreview } from "@/contracts";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const target: WormholeTransferPreview = {
  id: "wormhole",
  sourceSpaceId: "source",
  color: "#336699",
  rank: "1",
  target: { spaceId: "target", spaceName: "Support", spaceColor: "#336699", columnId: "column", columnName: "Inbox", columnIsDone: false },
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  canWrite: true,
  audience: { memberCount: 8, guestCount: 1, serviceAccountCount: 0, public: false, authenticated: false },
  removedTags: ["Internal", "Planning"],
  removedAssignees: ["Alex"],
  removedDependencies: ["Review invoice"],
  removedDependencyCount: 5,
  commentsMove: true,
  attachmentsMove: true,
};
if (!isServer)
  test("loads once on opening, preserves rows during refresh, and keeps plain targets usable after failure", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let mode: "error" | "ready" | "empty" | "missing" = "error";
    let releaseFirst!: () => void;
    let hold: Promise<void> | undefined = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls++;
        await hold;
        return mode === "error" || mode === "missing"
          ? Response.json({ error: "Unavailable" }, { status: mode === "missing" ? 404 : 503 })
          : Response.json(mode === "empty" ? [] : [target, { ...target, id: "readonly", canWrite: false, audience: null }]);
      },
      { preconnect: originalFetch.preconnect },
    );
    const prototype = dom.window.HTMLElement.prototype;
    const show = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
    const { default: WormholeSelect } = await import("./WormholeSelect");
    const { LocaleProvider } = await import("@k2b/ui");
    delegateEvents(["click", "pointermove"]);
    const [item, setItem] = createSignal("item");
    const [wormholes, setWormholes] = createSignal([target]);
    const choices: string[] = [];
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <WormholeSelect spaceId="source" wormholes={wormholes()} itemId={item()} disabled={false} onChoose={(id) => choices.push(id)} />
        </LocaleProvider>
      ),
      dom.root,
    );
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Bun.sleep(5);
    };
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      const close = () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flush();
      expect(calls).toBe(0);
      trigger.click();
      await flush();
      expect(calls).toBe(1);
      expect(dom.root.textContent).toContain("Die Folgen des Verschiebens werden geprüft…");
      expect(dom.root.textContent).not.toContain("konnten nicht geprüft werden");
      releaseFirst();
      hold = undefined;
      await flush();
      expect(dom.root.textContent).toContain("Die Folgen des Verschiebens konnten nicht geprüft werden.");
      const fallback = dom.root.querySelector<HTMLElement>('[role="option"]')!;
      expect(fallback.getAttribute("aria-disabled")).not.toBe("true");
      fallback.click();
      expect(choices).toEqual(["wormhole"]);
      mode = "ready";
      trigger.click();
      await flush();
      expect(calls).toBe(2);
      const rows = [...dom.root.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(rows[0]!.textContent).toContain("2 Tags");
      expect(rows[0]!.textContent).toContain("5 Abhängigkeiten");
      expect(rows[1]!.textContent).toContain("Kein Schreibrecht");
      rows[1]!.click();
      expect(choices).toEqual(["wormhole"]);
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await flush();
      expect(dom.root.textContent).toContain("8 Mitglieder");
      expect(dom.root.textContent).toContain("1 Gast");
      expect(dom.root.textContent).toContain("Review invoice");
      expect(dom.root.querySelector('input[type="search"]')).toBeNull();
      setWormholes([{ ...target, updatedAt: "2026-10-01T12:01:00Z" }]);
      await flush();
      expect(calls).toBe(2);
      close();
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      trigger.click();
      await flush();
      expect(calls).toBe(3);
      expect(dom.root.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(dom.root.textContent).not.toContain("Optionen werden geladen");
      release();
      hold = undefined;
      await flush();
      close();
      mode = "missing";
      trigger.click();
      await flush();
      expect(dom.root.querySelector('[role="option"]')?.getAttribute("aria-disabled")).not.toBe("true");
      close();
      mode = "empty";
      setWormholes([]);
      setItem("another");
      await flush();
      expect(calls).toBe(4);
      trigger.click();
      await flush();
      expect(calls).toBe(5);
      expect(dom.root.textContent).toContain("Keine Ziele eingerichtet");
    } finally {
      releaseFirst();
      dispose();
      globalThis.fetch = originalFetch;
      if (show) Object.defineProperty(prototype, "showPopover", show);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (hide) Object.defineProperty(prototype, "hidePopover", hide);
      else Reflect.deleteProperty(prototype, "hidePopover");
      dom.cleanup();
    }
  }, 30_000);

if (!isServer)
  test("known destinations beyond the preview budget remain selectable with unknown consequences", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const targets = Array.from({ length: 101 }, (_, index) => ({ ...target, id: `wormhole${index}` }));
    globalThis.fetch = Object.assign(async () => Response.json(targets.slice(0, 100)), { preconnect: originalFetch.preconnect });
    const prototype = dom.window.HTMLElement.prototype;
    const show = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
    const { default: WormholeSelect } = await import("./WormholeSelect");
    delegateEvents(["click"]);
    const choices: string[] = [];
    const dispose = render(
      () => <WormholeSelect spaceId="source" wormholes={targets} itemId="item" disabled={false} onChoose={(id) => choices.push(id)} />,
      dom.root,
    );
    try {
      dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!.click();
      for (let i = 0; i < 30; i++) await Bun.sleep(5);
      const rows = dom.root.querySelectorAll<HTMLElement>('[role="option"]');
      expect(rows).toHaveLength(101);
      expect(rows[100]!.textContent).toContain("Move consequences could not be checked.");
      rows[100]!.click();
      expect(choices).toEqual(["wormhole100"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      if (show) Object.defineProperty(prototype, "showPopover", show);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (hide) Object.defineProperty(prototype, "hidePopover", hide);
      else Reflect.deleteProperty(prototype, "hidePopover");
      dom.cleanup();
    }
  }, 30_000);
