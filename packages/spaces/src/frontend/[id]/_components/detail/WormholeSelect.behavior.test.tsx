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
  commentsMove: true,
  attachmentsMove: true,
};
if (!isServer)
  test("wormhole preview explains losses before committing and recovers through retry", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let mode: "error" | "ready" | "empty" | "denied" = "error";
    globalThis.fetch = Object.assign(
      async () =>
        mode === "error"
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : mode === "denied"
            ? Response.json({ error: "Denied" }, { status: 403 })
            : Response.json(mode === "empty" ? [] : [target, { ...target, id: "readonly", canWrite: false }]),
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
    const [revision, setRevision] = createSignal("1");
    const choices: string[] = [];
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <WormholeSelect spaceId="source" revision={revision()} itemId={item()} disabled={false} onChoose={(id) => choices.push(id)} />
        </LocaleProvider>
      ),
      dom.root,
    );
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Bun.sleep(5);
    };
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      trigger.click();
      expect(dom.root.textContent).toContain("Optionen werden geladen");
      await flush();
      const retry = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Erneut versuchen"),
      )!;
      expect(retry).toBeDefined();
      mode = "ready";
      retry.click();
      await flush();
      const rows = [...dom.root.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(rows[0]!.textContent).toContain("2 Tags");
      expect(rows[1]!.textContent).toContain("Kein Schreibrecht");
      rows[1]!.click();
      expect(choices).toEqual([]);
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await flush();
      expect(dom.root.textContent).toContain("8 Mitglieder");
      expect(dom.root.textContent).toContain("1 Gast");
      expect(dom.root.textContent).toContain("Review invoice");
      expect(dom.root.textContent).toContain("Kommentare und Anhänge ziehen mit");
      expect(dom.root.querySelector('input[type="search"]')).toBeNull();
      rows[0]!.click();
      expect(choices).toEqual(["wormhole"]);
      mode = "empty";
      setRevision("2");
      trigger.click();
      await flush();
      expect(dom.root.textContent).toContain("Keine Ziele eingerichtet");
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      mode = "empty";
      setItem("empty");
      trigger.click();
      await flush();
      expect(dom.root.textContent).toContain("Keine Ziele eingerichtet");
      mode = "denied";
      setItem("denied");
      await flush();
      expect(dom.root.textContent).toContain("Kein Schreibrecht");
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
