import { expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

// Load once outside any test, so the cold Solid transform of the invitation's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { prompts } = await import("@k2b/ui");
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { default: Invitation } = await import("./MailCalendarInvitation");
    return { prompts, collectContextAwareCommands, Invitation };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

if (!isServer)
  test("calendar actions require write access and never apply a confirmed import to a changed message", async () => {
    const dom = createDomTestHarness();
    const { prompts, collectContextAwareCommands, Invitation } = modules!;
    const originalFetch = globalThis.fetch;
    const prototype = dom.window.HTMLElement.prototype;
    const show = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const hide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    Object.defineProperty(prototype, "showPopover", { configurable: true, value() {} });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value() {} });
    delegateEvents(["click"]);
    const writes: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") writes.push(String(url));
        if (String(url).endsWith("calendar-destinations"))
          return Response.json({
            items: [
              {
                id: "Space1",
                name: "Calendar",
                color: "#3b82f6",
                audience: { memberCount: 8, guestCount: 1, serviceAccountCount: 0, public: false, authenticated: false },
              },
            ],
            selectedSpaceId: "Space1",
          });
        return Response.json({
          invitation: {
            title: "Review",
            method: "request",
            status: "confirmed",
            startsAt: "2026-09-16T10:00:00Z",
            endsAt: "2026-09-16T11:00:00Z",
            organizer: { address: "person@example.test", name: "Person" },
          },
          existing: null,
          response: null,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const choose = spyOn(prompts, "search").mockResolvedValue({ value: { id: "Space1" }, label: "Calendar" });
    let confirm: (value: boolean) => void = () => {};
    const confirmation = spyOn(prompts, "confirm").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const [message, setMessage] = createSignal("Msg001");
    const [writable, setWritable] = createSignal(true);
    const dispose = render(
      () => (
        <Invitation
          mailboxId="Box001"
          messageId={message()}
          requestUrl="/app/mail/Box001"
          canWrite={writable()}
          dateConfig={{ locale: "en", timeZone: "Europe/Berlin" }}
        />
      ),
      dom.root,
    );
    try {
      for (let i = 0; i < 100 && collectContextAwareCommands().length !== 2; i++) await Bun.sleep(10);
      expect(collectContextAwareCommands()).toHaveLength(2);
      const calendar = dom.root.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      calendar.click();
      await Bun.sleep(0);
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("8 members");
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("1 guest");
      expect(dom.root.querySelector(".k2b-rich-select__preview")).toBeNull();
      calendar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const action = collectContextAwareCommands().find((command) => command.id.endsWith("calendar.import"))!;
      if (typeof action.action !== "function") throw new Error("Expected local import action");
      const running = action.action();
      for (let i = 0; i < 100 && !confirmation.mock.calls.length; i++) await Bun.sleep(10);
      expect(confirmation).toHaveBeenCalledTimes(1);
      setMessage("Msg002");
      confirm(true);
      await running;
      expect(writes).toEqual([]);
      setWritable(false);
      await Bun.sleep(0);
      expect(collectContextAwareCommands()).toHaveLength(0);
    } finally {
      dispose();
      choose.mockRestore();
      confirmation.mockRestore();
      globalThis.fetch = originalFetch;
      if (show) Object.defineProperty(prototype, "showPopover", show);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (hide) Object.defineProperty(prototype, "hidePopover", hide);
      else Reflect.deleteProperty(prototype, "hidePopover");
      dom.cleanup();
    }
  });

if (!isServer)
  test("an already imported invitation exposes a calendar load error and retry without a picker", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let fail = true;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input).endsWith("calendar-destinations"))
          return fail
            ? Response.json({ message: "Unavailable" }, { status: 503 })
            : Response.json({ items: [{ id: "Space1", name: "Calendar", color: "#3b82f6" }], selectedSpaceId: "Space1" });
        return Response.json({
          invitation: {
            title: "Review",
            method: "request",
            status: "confirmed",
            startsAt: "2026-09-16T10:00:00Z",
            endsAt: "2026-09-16T11:00:00Z",
            organizer: { address: "person@example.test", name: "Person" },
          },
          existing: { itemId: "Event1", spaceId: "Space1", href: "/app/spaces/Space1?item=Event1", sequence: 1, method: "request" },
          response: null,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    delegateEvents(["click"]);
    const { Invitation } = modules!;
    const dispose = render(
      () => (
        <Invitation
          mailboxId="Box001"
          messageId="Msg001"
          requestUrl="/app/mail/Box001"
          canWrite
          dateConfig={{ locale: "en", timeZone: "Europe/Berlin" }}
        />
      ),
      dom.root,
    );
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Bun.sleep(5);
    };
    try {
      await flush();
      expect(dom.root.querySelector('[role="combobox"]')).toBeNull();
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("calendar");
      const retry = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Retry"))!;
      expect(retry).toBeDefined();
      fail = false;
      retry.click();
      await flush();
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
      expect(
        [...dom.root.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.includes("Accept") && !button.disabled,
        ),
      ).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
