import { expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";

if (!isServer)
  test("contact Commands read with current authority, never create a draft, and recover from denied access", async () => {
    const dom = createDomTestHarness();
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let denied = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/contacts/contact.read"))
          return denied
            ? Response.json({ code: "FORBIDDEN", message: "Not allowed" }, { status: 403 })
            : Response.json({
                data: {
                  id: "cont01",
                  bookId: "book01",
                  displayName: "Ada Example",
                  companyName: null,
                  jobTitle: null,
                  emails: [{ email: "ada@example.test", label: "Work" }],
                  phones: [],
                  updatedAt: "2026-08-18T12:00:00.000Z",
                },
              });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailComposeIntentPage } = await import("./MailComposeIntentPage.island");
    delegateEvents(["click"]);
    const dispose = render(
      () => (
        <MailComposeIntentPage
          mailboxes={[{ id: "mail01", name: "Mailbox", description: null }]}
          initialMailboxId=""
          autoStart={false}
          mailto={null}
          returnHref={null}
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        />
      ),
      dom.root,
    );
    const target = { command: "mail.compose", input: { contact: { type: "contacts.contact", id: "cont01" } } };
    try {
      await openCommand(target.command, target.input);
      expect(dom.root.textContent).toContain("ada@example.test");
      expect(calls).toEqual(["/api/capabilities/v1/queries/contacts/contact.read"]);
      denied = true;
      await openCommand(target.command, target.input);
      expect(dom.root.textContent).not.toContain("ada@example.test");
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
      denied = false;
      const retry = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Retry"),
      );
      expect(retry).toBeDefined();
      retry!.click();
      for (let i = 0; i < 100 && !dom.root.textContent?.includes("ada@example.test"); i++) await Bun.sleep(10);
      expect(dom.root.textContent).toContain("ada@example.test");
      expect(calls).toHaveLength(3);
      expect(calls.every((url) => url.endsWith("/contacts/contact.read"))).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
