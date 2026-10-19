import { expect, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";

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

if (!isServer)
  test.each([
    ["the built-in Contacts defaults", DEFAULT_MAIL_CONTACT_DIRECTORY, true],
    ["a directory without create", { ...DEFAULT_MAIL_CONTACT_DIRECTORY, listWritableBooks: null, create: null }, false],
  ])("offers New contact for an unmatched participant with %s", async (_label, directory, offered) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          conversationId: "Conv01",
          participants: [{ email: "ada@example.test", displayName: "Ada Example" }],
          contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
          spaces: { status: "ready", items: [], truncated: false },
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailConversationContext } = await import("./MailConversationContext");
    const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
    const dispose = render(
      () => (
        <MailContactDirectoryProvider value={directory}>
          <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl="/app/mail/Box001" active />
        </MailContactDirectoryProvider>
      ),
      dom.root,
    );
    try {
      for (let i = 0; i < 100 && !dom.root.textContent?.includes("ada@example.test"); i++) await Bun.sleep(10);
      expect(dom.root.textContent).toContain("ada@example.test");
      expect(dom.root.textContent?.includes("New contact")).toBe(offered);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

test.skipIf(isServer)(
  "New contact stays busy during code loading and ends without opening the book picker when loading fails",
  async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          conversationId: "Conv01",
          participants: [{ email: "ada@example.test", displayName: "Ada Example" }],
          contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
          spaces: { status: "ready", items: [], truncated: false },
        }),
      { preconnect: originalFetch.preconnect },
    );
    const reload = await import("@k2b/cloud/browser/reload");
    const { prompts } = await import("@k2b/ui");
    const { default: MailConversationContext } = await import("./MailConversationContext");
    let finish!: () => void;
    const load = spyOn(reload, "importOnDemand").mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const search = spyOn(prompts, "search").mockResolvedValue(undefined);
    delegateEvents(["click"]);
    const dispose = render(
      () => <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl="/app/mail/Box001" active />,
      dom.root,
    );
    try {
      for (let i = 0; i < 100 && !dom.root.textContent?.includes("New contact"); i++) await Bun.sleep(10);
      const trigger = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("New contact"),
      )!;
      trigger.click();
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(trigger.disabled).toBe(false);
      expect(trigger.querySelector("i.ti-loader-2")).not.toBeNull();
      trigger.click();
      expect(load).toHaveBeenCalledTimes(1);
      finish();
      await Bun.sleep(0);
      expect(trigger.hasAttribute("aria-busy")).toBe(false);
      expect(search).not.toHaveBeenCalled();
    } finally {
      dispose();
      load.mockRestore();
      search.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  },
);

test.skipIf(isServer)("a failed contact-mutation code load neither creates a contact nor refreshes the context as a success", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json({
        conversationId: "Conv01",
        participants: [{ email: "ada@example.test", displayName: "Ada Example" }],
        contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
        spaces: { status: "ready", items: [], truncated: false },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const reload = await import("@k2b/cloud/browser/reload");
  const { prompts } = await import("@k2b/ui");
  const { default: MailConversationContext } = await import("./MailConversationContext");
  const load = spyOn(reload, "importOnDemand")
    .mockImplementationOnce((loader) => loader())
    .mockResolvedValueOnce(undefined);
  const search = spyOn(prompts, "search").mockResolvedValue({ value: { id: "Book01", name: "People" }, label: "People" });
  const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
  delegateEvents(["click"]);
  const dispose = render(
    () => <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl="/app/mail/Box001" active />,
    dom.root,
  );
  try {
    for (let i = 0; i < 100 && !dom.root.textContent?.includes("New contact"); i++) await Bun.sleep(10);
    const before = requests;
    const trigger = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("New contact"),
    )!;
    trigger.click();
    for (let i = 0; i < 100 && trigger.hasAttribute("aria-busy"); i++) await Bun.sleep(10);
    expect(load).toHaveBeenCalledTimes(2);
    expect(requests).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    expect(trigger.hasAttribute("aria-busy")).toBe(false);
  } finally {
    dispose();
    load.mockRestore();
    search.mockRestore();
    errors.mockRestore();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

if (!isServer)
  test.each([
    ["absent directory", false, "absent", false, false],
    ["registered provider failure", true, "unavailable", true, true],
    ["server reports absent", true, "absent", false, false],
    ["provider installed since the page loaded", false, "ready", true, false],
  ] as const)("contact section: %s", async (_label, mapped, status, visible, failed) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Response.json({
          conversationId: "Conv01",
          participants: [],
          contacts: { status, items: [], matchedEmails: [], nextCursor: null },
          spaces: { status: "ready", items: [], truncated: false },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailConversationContext } = await import("./MailConversationContext");
    const { MailContactDirectoryProvider } = await import("./mail-contact-directory-context");
    const directory = mapped
      ? DEFAULT_MAIL_CONTACT_DIRECTORY
      : { suggest: null, resolve: null, read: null, listWritableBooks: null, create: null };
    delegateEvents(["click"]);
    const dispose = render(
      () => (
        <MailContactDirectoryProvider value={directory}>
          <MailConversationContext mailboxId="Box001" conversationId="Conv01" requestUrl="/app/mail/Box001" active />
        </MailContactDirectoryProvider>
      ),
      dom.root,
    );
    try {
      if (!mapped) expect(dom.root.querySelector('section[aria-label="Contacts"]')).toBeNull();
      for (let i = 0; i < 100 && !dom.root.textContent?.includes("Spaces task"); i++) await Bun.sleep(10);
      expect(dom.root.querySelector('section[aria-label="Spaces"]')).not.toBeNull();
      expect(Boolean(dom.root.querySelector('section[aria-label="Contacts"]'))).toBe(visible);
      expect(dom.root.textContent?.includes("Contacts unavailable")).toBe(failed);
      expect(Boolean(Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry")))).toBe(failed);
      expect(requests.every((url) => url.includes("/context"))).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
