import { expect, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (!isServer)
  test("calendar actions require write access and never apply a confirmed import to a changed message", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { default: Invitation } = await import("./MailCalendarInvitation");
    const originalFetch = globalThis.fetch;
    const writes: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") writes.push(String(url));
        if (String(url).endsWith("calendar-destinations"))
          return Response.json({ items: [{ id: "Space1", name: "Calendar", color: "blue" }], selectedSpaceId: "Space1" });
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
      dom.cleanup();
    }
  });
