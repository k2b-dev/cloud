import { expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (!isServer)
  test.each([
    [
      "https://cloud.example/app/mail/Box001?view=mine&conversation=Conv01&search=invoice#message",
      "/app/mail/Box001?view=mine&conversation=Conv01&search=invoice#message",
    ],
    ["/app/mail?view=waiting&mailbox=Box001&conversation=Conv01", "/app/mail?view=waiting&mailbox=Box001&conversation=Conv01"],
  ])("conversation buttons and context Commands retain their return view: %s", async (requestUrl, returnTo) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          conversationId: "Conv01",
          participants: [],
          contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
          spaces: { status: "ready", items: [], truncated: false },
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { registerCommandHandler } = await import("@k2b/cloud/browser/commands");
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { default: MailConversationContext } = await import("./MailConversationContext");
    const calls: unknown[] = [];
    const stops = ["task", "event"].map((kind) =>
      registerCommandHandler(`spaces.${kind}.compose`, z.unknown(), (input, options) => {
        calls.push({ input, options });
      }),
    );
    delegateEvents(["click"]);
    const dispose = render(
      () => <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl={requestUrl} active subject="Invoice" />,
      dom.root,
    );
    try {
      for (let i = 0; i < 100 && collectContextAwareCommands().length !== 3; i++) await Bun.sleep(10);
      const actions = collectContextAwareCommands();
      expect(actions).toHaveLength(3);
      expect(actions.find((action) => action.id.endsWith("spaces.link"))?.description).toContain("existing Spaces entry");
      for (const action of actions.filter((action) => !action.id.endsWith("spaces.link"))) {
        expect(typeof action.action).toBe("object");
        if (typeof action.action === "function" || !("command" in action.action)) throw new Error("Expected a linkable Command");
        expect(action.scope).toBe("selection");
        expect(action.action.options).toEqual({ returnTo });
        expect(action.action.input).toEqual({ source: { type: "mail.conversation", id: "Conv01" } });
      }
      const buttons = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"));
      for (const label of ["Spaces task", "Spaces event"]) {
        const button = buttons.find((button) => button.textContent?.includes(label));
        expect(button).toBeDefined();
        button!.click();
        await Bun.sleep(0);
      }
      expect(calls).toEqual([1, 2].map(() => ({ input: { source: { type: "mail.conversation", id: "Conv01" } }, options: { returnTo } })));
    } finally {
      dispose();
      stops.forEach((stop) => stop());
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
