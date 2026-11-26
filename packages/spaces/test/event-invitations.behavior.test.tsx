import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { buttonNamed, installV2Globals } from "./v2-dom";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(20);
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

  test("the section prepares an invitation in a dialog that Escape closes and that opens again", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
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
    // The section's action runs the `spaces.event.invite` Command; the page mounts its handler next to the detail.
    const dispose = render(() => {
      createSpaceCommands({});
      return createComponent(EventInvitations, { spaceId: "Space1", itemId: "Item01", title: "Review" });
    }, dom.root);
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');

    try {
      await settle();
      const trigger = buttonNamed(dom, "Prepare invitation")!;
      expect(trigger).toBeDefined();
      // Without a sent invitation there is nothing to cancel.
      expect(buttonNamed(dom, "Prepare cancellation")).toBeUndefined();

      trigger.click();
      await settle();
      expect(dialog()?.textContent).toContain("Review before sending");
      expect(dialog()?.textContent).toContain(
        "Nothing is sent yet. People who already received this invitation will get an update when you send it.",
      );
      expect(dialog()?.textContent).toContain("Continue in Mail");

      dialog()!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
      await settle();
      expect(dialog()).toBeNull();

      buttonNamed(dom, "Prepare invitation")!.click();
      await settle();
      expect(dialog()?.textContent).toContain("Prepare invitation");
      buttonNamed(dom, "Cancel")!.click();
      await settle();
      expect(dialog()).toBeNull();
    } finally {
      dispose();
      await settle();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the section names five attendees and counts the rest; the dialog says who sends and who receives", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { createSpaceCommands } = await import("../src/frontend/space-commands");
    const { default: EventInvitations } = await import("../src/frontend/[id]/_components/detail/EventInvitations");
    const attendees = Array.from({ length: 7 }, (_, index) => ({ name: null, address: `person${index}@example.org` }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/spaces/item.read"))
          return Response.json({ data: { kind: "event", spaceId: "Space1", title: "Review" } });
        if (String(url).endsWith("/invitation-context")) return Response.json({ ...invitationContext, attendees });
        throw new Error(`Unexpected request ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const dispose = render(() => {
      createSpaceCommands({});
      return createComponent(EventInvitations, { spaceId: "Space1", itemId: "Item01", title: "Review" });
    }, dom.root);
    try {
      await settle();
      expect(dom.root.textContent).toContain("person4@example.org");
      expect(dom.root.textContent).not.toContain("person5@example.org");
      expect(dom.root.textContent).toContain("2 more attendees");

      buttonNamed(dom, "Prepare invitation")!.click();
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("Choose the organizer identity and recipients.");
      expect(dialog?.textContent).toContain("Choose the sender and recipients.");
    } finally {
      dispose();
      await settle();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
