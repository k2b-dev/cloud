import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};

const invitationContext = {
  mailboxes: [
    {
      id: "Box001",
      name: "Team",
      identities: [{ id: "Ident1", label: "Team", from: { name: null, address: "team@example.org" }, isDefault: true }],
    },
  ],
  attendees: [],
  canCancel: false,
  lastDelivery: null,
};

describe("Spaces event invitations", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("closes with Escape and opens again", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("@k2b/ui");
    const { createSpaceCommands } = await import("../src/frontend/space-commands");
    const { default: EventInvitations } = await import("../src/frontend/[id]/_components/detail/EventInvitations");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/spaces/item.read"))
          return Response.json({ data: { kind: "event", spaceId: "Space1", title: "Review" } });
        if (String(url).endsWith("/invitation-context")) return Response.json(invitationContext);
        throw new Error(`Unexpected request ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    // The trigger runs the `spaces.event.invite` Command; the page mounts its handler next to the detail panel.
    const dispose = render(() => {
      createSpaceCommands({});
      return createComponent(EventInvitations, { spaceId: "Space1", itemId: "Item01", title: "Review" });
    }, dom.root);

    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>("button")!;
      expect(trigger.textContent).toContain("Prepare invitation");

      trigger.click();
      await settle();
      let dialog = dom.document.querySelector<HTMLDialogElement>("dialog")!;
      expect(dialogCore.isOpen()).toBe(true);
      expect(dialog.textContent).toContain("Review before sending");
      expect(dialog.textContent).toContain(
        "Nothing is sent yet. People who already received this invitation will get an update when you send it.",
      );
      expect(dialog.textContent).toContain("Continue in Mail");

      expect(dialog.dispatchEvent(new Event("cancel", { cancelable: true }))).toBe(false);
      await settle();
      expect(dialogCore.isOpen()).toBe(false);
      expect(dom.document.querySelector("dialog")).toBeNull();

      trigger.click();
      await settle();
      dialog = dom.document.querySelector<HTMLDialogElement>("dialog")!;
      expect(dialogCore.isOpen()).toBe(true);
      expect(dialog.textContent).toContain("Prepare invitation");
    } finally {
      dialogCore.close();
      await settle();
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
