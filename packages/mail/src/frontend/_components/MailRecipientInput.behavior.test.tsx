import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory";

// This is a DOM behavior test: no browser process or network is used.
if (!isServer)
  test.each([
    ["mailbox alone", false, true, false, false],
    ["contacts first with deduplication", true, true, false, false],
    ["contacts survive mailbox failure", true, true, true, false],
    ["both failing preserve typing", true, true, true, true],
    ["no mailbox ID", true, false, false, false],
    ["neither source", false, false, false, false],
  ] as const)("recipient suggestions: %s", async (_label, contacts, mailbox, mailboxFails, contactFails) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const mailboxItem = (address: string, displayName: string | null) => ({
      address,
      displayName,
      writtenTo: true,
      lastSeenAt: "2026-10-19T12:00:00.000Z",
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push(url);
        if (url.includes("recipient-suggestions")) {
          if (mailboxFails) return Response.json({ message: "Unavailable" }, { status: 503 });
          return Response.json({ items: [mailboxItem("ada@example.test", "Mailbox Ada"), mailboxItem("address-only@example.test", null)] });
        }
        if (contactFails) return Response.json({ message: "Unavailable" }, { status: 503 });
        return Response.json({
          data: [
            {
              contactId: "Contact01",
              bookId: "Book01",
              displayName: "Contact Ada",
              companyName: null,
              jobTitle: null,
              emails: [{ email: "ADA@example.test", label: null }],
              phones: [],
              contactPointsTruncated: false,
              updatedAt: "2026-10-19T12:00:00.000Z",
            },
          ],
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailRecipientInput } = await import("./MailRecipientInput");
    const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
    let recipients: string[] = [];
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(() => {
      const [value, setValue] = createSignal<string[]>([]);
      return (
        <MailContactDirectoryProvider
          value={{ ...DEFAULT_MAIL_CONTACT_DIRECTORY, suggest: contacts ? DEFAULT_MAIL_CONTACT_DIRECTORY.suggest : null }}
        >
          <MailRecipientInput
            placeholder="To"
            value={value}
            onChange={(next) => {
              recipients = next;
              setValue(next);
            }}
            mailboxId={mailbox ? "Box001" : undefined}
          />
        </MailContactDirectoryProvider>
      );
    }, dom.root);
    try {
      const input = dom.root.querySelector("input")!;
      input.value = "ad";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Bun.sleep(300);
      const options = Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      if (mailbox && !mailboxFails) {
        expect(options).toHaveLength(2);
        expect(options[0]?.textContent).toContain(contacts ? "Contact Ada" : "Mailbox Ada");
        expect(options.filter((option) => option.textContent?.includes("ada@example.test"))).toHaveLength(1);
        const mailboxOption = options[1]!;
        expect(mailboxOption.querySelector(".ti-mail")).not.toBeNull();
        expect(mailboxOption.querySelector(".sr-only")?.textContent).toBe("From this mailbox");
        expect(mailboxOption.textContent?.match(/address-only@example.test/g)).toHaveLength(1);
        mailboxOption.click();
        expect(recipients).toEqual(["address-only@example.test"]);
      } else if (contacts && !contactFails) {
        expect(options).toHaveLength(1);
        expect(options[0]?.textContent).toContain("Contact Ada");
        expect(options[0]?.querySelector(".ti-user")).not.toBeNull();
      } else {
        expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
        expect(input.value).toBe("ad");
      }
      expect(requests.some((url) => url.includes("recipient-suggestions"))).toBe(mailbox);
      if (!contacts && !mailbox) expect(requests).toHaveLength(0);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("shows mailbox suggestions while contacts are pending and commits a named suggestion", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const contacts = Promise.withResolvers<Response>();
    let mailboxAnswered = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.includes("recipient-suggestions")) return contacts.promise;
        mailboxAnswered = true;
        return Response.json({
          items: [{ address: "ada@example.test", displayName: "Ada Lovelace", lastSeenAt: "2026-10-19T12:00:00.000Z", writtenTo: true }],
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailRecipientInput } = await import("./MailRecipientInput");
    const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
    let recipients: string[] = [];
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(
      () => (
        <MailContactDirectoryProvider value={DEFAULT_MAIL_CONTACT_DIRECTORY}>
          <MailRecipientInput
            placeholder="To"
            value={() => recipients}
            onChange={(next) => {
              recipients = next;
            }}
            mailboxId="Box001"
          />
        </MailContactDirectoryProvider>
      ),
      dom.root,
    );
    try {
      const input = dom.root.querySelector("input")!;
      input.value = "ad";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < 100 && !mailboxAnswered; i++) await Bun.sleep(10);
      expect(mailboxAnswered).toBe(true);
      for (let i = 0; i < 100 && !dom.root.querySelector('[role="option"]'); i++) await Bun.sleep(10);
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("Ada Lovelace");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      contacts.resolve(
        Response.json({
          data: [
            {
              contactId: "Ctc001",
              bookId: "Book01",
              contactPointsTruncated: false,
              updatedAt: "2026-10-19T12:00:00.000Z",
              displayName: "Adam Contact",
              companyName: null,
              jobTitle: null,
              emails: [{ email: "adam@example.test", label: null }],
              phones: [],
            },
          ],
        }),
      );
      for (let i = 0; i < 100 && dom.root.querySelectorAll('[role="option"]').length < 2; i++) await Bun.sleep(10);
      expect(dom.root.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("Adam Contact");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(recipients).toEqual(["Ada Lovelace <ada@example.test>"]);
    } finally {
      contacts.resolve(Response.json({ data: [] }));
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("arrow keys move through the suggestions, Enter takes the highlighted one and Escape closes the list", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          items: ["ada", "grace"].map((name) => ({
            address: `${name}@example.test`,
            displayName: null,
            writtenTo: false,
            lastSeenAt: "2026-10-19T12:00:00.000Z",
          })),
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailRecipientInput } = await import("./MailRecipientInput");
    const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
    let recipients: string[] = [];
    delegateEvents(["input", "keydown"]);
    const dispose = render(
      () => (
        <MailContactDirectoryProvider value={{ ...DEFAULT_MAIL_CONTACT_DIRECTORY, suggest: null }}>
          <MailRecipientInput
            placeholder="To"
            value={() => recipients}
            onChange={(next) => {
              recipients = next;
            }}
            mailboxId="Box001"
          />
        </MailContactDirectoryProvider>
      ),
      dom.root,
    );
    const press = (input: HTMLInputElement, key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const typeQuery = async (input: HTMLInputElement) => {
      input.value = "ex";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < 100 && dom.root.querySelectorAll('[role="option"]').length < 2; i++) await Bun.sleep(10);
    };
    try {
      const input = dom.root.querySelector("input")!;
      await typeQuery(input);
      const options = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      press(input, "ArrowDown");
      press(input, "ArrowDown");
      expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
      expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
      press(input, "ArrowDown");
      expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
      // Typing again drops the highlight, so Enter takes what was typed and never a stale entry.
      input.value = "grace@example.test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      // The old list answers another query, so the arrow keys cannot pick from it before the new lookup ends.
      press(input, "ArrowDown");
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      press(input, "Enter");
      expect(recipients).toEqual(["grace@example.test"]);
      recipients = [];
      await typeQuery(input);
      press(input, "ArrowDown");
      press(input, "ArrowDown");
      press(input, "Enter");
      expect(recipients).toEqual(["grace@example.test"]);
      expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
      await typeQuery(input);
      // An IME composition keeps its keys: no highlight, no commit.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      expect(recipients).toEqual(["grace@example.test"]);
      press(input, "Escape");
      expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
      expect(input.value).toBe("ex");
      // Escape during a pending lookup ends it, so its answer never reopens the list.
      input.value = "exa";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      press(input, "Escape");
      await Bun.sleep(300);
      expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
      expect(recipients).toEqual(["grace@example.test"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
