import { expect, spyOn, test } from "bun:test";
import { type ComponentProps, createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import type MailConversationReaderComponent from "./MailConversationReader";

// Load once outside any test, so the cold Solid transform of the reader's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { MailConversationReader: (await import("./MailConversationReader")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const now = "2026-08-16T12:00:00.000Z";
const envelopeOnly: MessageDetail = {
  id: "Msg001",
  subject: "Quarterly review",
  messageId: "<quarterly-review@example.com>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Ada Lovelace", address: "ada@example.com" }],
  to: [],
  preview: "",
  hasAttachments: false,
  replyTo: [],
  cc: [],
  flags: [],
  keywords: [],
  hydrationStatus: "envelope",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 64,
  plainText: null,
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: false,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, sender: "ada@example.com", domain: "example.com" },
  delivery: null,
  attachments: [],
};

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the Mail reader test condition");
};

const readerProps: ComponentProps<typeof MailConversationReaderComponent> = {
  mailboxId: "Box001",
  requestUrl: "/app/mail/Box001?conversation=Conv01",
  canWrite: true,
  canAdmin: false,
  mailboxWide: true,
  identities: [],
  onOpenDeliverySettings: () => undefined,
  selectionKey: "Conv01",
  selectedConversationId: "Conv01",
  selectedMessageId: null,
  unread: false,
  flagged: false,
  inJunk: false,
  keep: null,
  reference: null,
  subject: envelopeOnly.subject,
  messages: [envelopeOnly],
  activity: [],
  conversationSummary: null,
  conversationDrafts: [],
  totalMessageCount: 1,
  error: null,
  dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
  readingFormat: "automatic",
  theme: "light",
  calendarIntegrationAvailable: false,
  listCollapsed: false,
  detailsOpen: false,
  toolbarActions: ["reply"],
  onRestoreList: () => undefined,
  onToggleDetails: () => undefined,
  onToolbarActionsChange: () => undefined,
  actionPending: false,
  structurePending: false,
  onAction: () => undefined,
  onOpenHref: () => undefined,
  onManageTags: () => undefined,
  onMergeConversation: () => undefined,
  onReassignMessage: () => undefined,
  onSplitMessage: () => undefined,
  onKeep: () => undefined,
  onStopKeeping: () => undefined,
  onSummarySaved: async () => undefined,
  onReconcile: async () => undefined,
  onReconcileAfterWrite: async () => undefined,
  onClose: () => undefined,
};

test.skipIf(isServer)("jumping to newest reads the person's motion choice at click time", async () => {
  const dom = createDomTestHarness();
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
  const { MailConversationReader } = modules!;
  const [messages, setMessages] = createSignal<MessageDetail[]>([envelopeOnly]);
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        get messages() {
          return messages();
        },
      }),
    dom.root,
  );
  const scroller = dom.root.querySelector<HTMLElement>('[data-scroll-preserve="mail-reader-Conv01"]')!;
  const scrollTo = spyOn(scroller, "scrollTo").mockImplementation(() => {});
  try {
    expect(dom.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (const [index, behavior] of ["auto", "smooth"].entries()) {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event("scroll"));
      setMessages((current) => [...current, { ...envelopeOnly, id: `Msg00${index + 2}`, internalDate: "2026-08-16T13:00:00.000Z" }]);
      const jump = () =>
        [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("1 new message"));
      await waitFor(() => jump() !== undefined);
      // Change the choice after render so the click must read the current attribute.
      if (behavior === "auto") document.documentElement.setAttribute("data-k2b-motion", "reduced");
      else document.documentElement.removeAttribute("data-k2b-motion");
      scrollTo.mockClear();
      jump()!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ behavior });
    }
  } finally {
    document.documentElement.removeAttribute("data-k2b-motion");
    scrollTo.mockRestore();
    dispose();
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    dom.cleanup();
  }
});

test.skipIf(isServer)(
  "the open reader replaces the pending body once hydration completes and offers a local refresh meanwhile",
  async () => {
    const dom = createDomTestHarness();
    const { MailConversationReader } = modules!;
    const [messages, setMessages] = createSignal<MessageDetail[]>([envelopeOnly]);
    let refreshes = 0;
    let finishRefresh!: () => void;
    const dispose = render(
      () =>
        createComponent(MailConversationReader, {
          ...readerProps,
          get messages() {
            return messages();
          },
          onReconcile: () => {
            refreshes += 1;
            return new Promise<void>((resolve) => {
              finishRefresh = resolve;
            });
          },
        }),
      dom.root,
    );
    try {
      const reader = dom.root.querySelector("[data-mail-print-root]");
      const card = () => dom.root.querySelector<HTMLElement>('[data-mail-message-id="Msg001"]')!;
      const pending = () => card().querySelector<HTMLElement>('.k2b-placeholder[data-state="loading"]');
      const refreshButton = () => pending()?.querySelector<HTMLButtonElement>("button") ?? null;

      expect(pending()?.getAttribute("role")).toBe("status");
      expect(pending()?.textContent).toContain("Body is still synchronizing");
      expect(refreshButton()?.textContent).toBe("Refresh message");
      expect(refreshButton()?.type).toBe("button");

      refreshButton()!.click();
      expect(refreshes).toBe(1);
      expect(refreshButton()?.disabled).toBe(true);
      expect(refreshButton()?.getAttribute("aria-busy")).toBe("true");
      refreshButton()!.click();
      expect(refreshes).toBe(1);
      finishRefresh();
      await waitFor(() => refreshButton()?.disabled === false);

      setMessages([{ ...envelopeOnly, hydrationStatus: "complete", plainText: "The numbers are attached.", sourceAvailable: true }]);
      await waitFor(() => pending() === null);

      expect(card().querySelector(".mail-message-body")?.textContent).toContain("The numbers are attached.");
      expect(card().textContent).not.toContain("Refresh message");
      expect(dom.root.querySelector("[data-mail-print-root]")).toBe(reader);
      expect(card().querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      dispose();
      dom.cleanup();
    }
  },
);

test.skipIf(isServer)("an opened quoted block stays open when a live update refreshes the conversation", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const hydrated: MessageDetail = {
    ...envelopeOnly,
    hydrationStatus: "complete",
    plainText: "Sounds good.\n\nOn Monday Ada wrote:\n> Shall we meet on Friday?",
    sourceAvailable: true,
  };
  const [messages, setMessages] = createSignal<MessageDetail[]>([hydrated]);
  const [activity, setActivity] = createSignal<ComponentProps<typeof MailConversationReaderComponent>["activity"]>([]);
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        get messages() {
          return messages();
        },
        get activity() {
          return activity();
        },
      }),
    dom.root,
  );
  try {
    const quote = () => dom.root.querySelector<HTMLDetailsElement>('[data-mail-message-id="Msg001"] details');
    await waitFor(() => quote() !== null);
    const card = dom.root.querySelector('[data-mail-message-id="Msg001"]');
    const opened = quote()!;
    opened.open = true;

    // Live invalidations reload activity and reconcile the detail snapshot.
    setActivity([]);
    setMessages([{ ...hydrated }]);
    await Bun.sleep(5);

    // The card stays mounted, so an HTML body keeps its frame document too.
    expect(dom.root.querySelector('[data-mail-message-id="Msg001"]')).toBe(card);
    expect(quote()).toBe(opened);
    expect(quote()?.open).toBe(true);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("a retained message card follows live delivery updates", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const delivery: NonNullable<MessageDetail["delivery"]> = {
    submissionId: "Sub001",
    draftId: "Dra001",
    state: "undo_window",
    attempt: 0,
    maxAttempts: 3,
    scheduledAt: now,
    undoUntil: null,
    acceptedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    acceptedRecipients: [],
    rejectedRecipients: [],
  };
  const outgoing: MessageDetail = { ...envelopeOnly, hydrationStatus: "complete", plainText: "See you Friday.", delivery };
  const [messages, setMessages] = createSignal<MessageDetail[]>([outgoing]);
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        get messages() {
          return messages();
        },
      }),
    dom.root,
  );
  try {
    const card = () => dom.root.querySelector<HTMLElement>('[data-mail-message-id="Msg001"]')!;
    const header = () => card().querySelector("button[aria-expanded]")!.textContent ?? "";
    await waitFor(() => card() !== null);
    const mounted = card();
    expect(header()).not.toContain("Sending");

    setMessages([{ ...outgoing, delivery: { ...delivery, state: "sending", attempt: 1 } }]);
    await waitFor(() => header().includes("Sending · 1/3"));

    setMessages([{ ...outgoing, delivery: { ...delivery, state: "sent", attempt: 1 } }]);
    await waitFor(() => !header().includes("Sending"));
    expect(card()).toBe(mounted);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("reply and forward Commands name an untitled conversation instead of quoting an empty subject", async () => {
  const dom = createDomTestHarness();
  const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
  const { MailConversationReader } = modules!;
  const dispose = render(
    () => createComponent(MailConversationReader, { ...readerProps, subject: "", messages: [{ ...envelopeOnly, subject: "" }] }),
    dom.root,
  );
  try {
    const commands = () => collectContextAwareCommands().filter((command) => /\.(reply|forward)$/.test(command.id));
    await waitFor(() => commands().length === 2);
    expect(commands().map((command) => command.description)).toEqual([
      "Reply to the sender of “(No subject)”.",
      "Forward “(No subject)” to another recipient.",
    ]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("a saved summary is announced to screen readers, with no toast", async () => {
  const dom = createDomTestHarness();
  const { prompts, toast } = await import("@k2b/ui");
  const form = spyOn(prompts, "form").mockResolvedValue({ summary: "Numbers agreed, invoice next week." });
  const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const originalFetch = globalThis.fetch;
  const puts: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PUT") return Response.json({ items: [] });
      puts.push(JSON.parse(String(init.body)));
      return Response.json({ summary: "Numbers agreed, invoice next week.", summaryRevision: 2, conversationRevision: 1 });
    },
    { preconnect: originalFetch.preconnect },
  );
  let saved = false;
  const { MailConversationReader } = modules!;
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        conversationSummary: { summary: "Numbers pending.", summaryRevision: 1, conversationRevision: 1 },
        onSummarySaved: async () => {
          saved = true;
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Edit summary"]')!.click();
    await waitFor(() => saved);
    await Bun.sleep(150);

    expect(puts).toEqual([{ expectedSummaryRevision: 1, summary: "Numbers agreed, invoice next week." }]);
    // The summary card shows the text; only a screen reader hears that it was saved.
    expect([...dom.document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent)).toEqual([
      "Summary saved",
    ]);
    expect(successes).not.toHaveBeenCalled();
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    form.mockRestore();
    successes.mockRestore();
    dom.cleanup();
  }
});

test.skipIf(isServer)("the reader follows every switch to another conversation and back", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const conversation = (index: number) => {
    const id = `Conv0${index}`;
    const message: MessageDetail = {
      ...envelopeOnly,
      id: `Msg00${index}`,
      subject: `Subject ${index}`,
      hydrationStatus: "complete",
      plainText: `Body ${index}`,
      sourceAvailable: true,
    };
    return { selectionKey: id, selectedConversationId: id, subject: message.subject, messages: [message] };
  };
  const [selected, setSelected] = createSignal(conversation(1));
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        get selectionKey() {
          return selected().selectionKey;
        },
        get selectedConversationId() {
          return selected().selectedConversationId;
        },
        get subject() {
          return selected().subject;
        },
        get messages() {
          return selected().messages;
        },
      }),
    dom.root,
  );
  try {
    const body = () => dom.root.querySelector("[data-mail-message-id] .mail-message-body")?.textContent ?? "";
    await waitFor(() => body().includes("Body 1"));
    // Leaving a conversation unmounts its open message body; that must not break the next render.
    for (const index of [2, 3, 1, 2]) {
      setSelected(conversation(index));
      await waitFor(() => body().includes(`Body ${index}`));
      expect([...dom.root.querySelectorAll("[data-mail-message-id]")].map((card) => card.getAttribute("data-mail-message-id"))).toEqual([
        `Msg00${index}`,
      ]);
    }
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("a reply without a verified sender names the reason and leads admins to the sender settings", async () => {
  const dom = createDomTestHarness();
  const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
  const { prompts } = await import("@k2b/ui");
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
  const error = spyOn(prompts, "error").mockResolvedValue(undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json([]), { preconnect: originalFetch.preconnect });
  const identity: SenderIdentity = {
    id: "Send01",
    mailboxId: "Box001",
    label: "Support",
    displayName: "Support",
    fromAddress: "support@example.com",
    replyTo: null,
    defaultCc: [],
    defaultBcc: [],
    defaultFormat: "markdown",
    defaultPriority: "normal",
    defaultDeliveryReceipt: false,
    defaultReadReceipt: false,
    vcard: null,
    envelopeSender: null,
    defaultSignatureTemplateId: null,
    transport: {
      mode: "mailbox",
      host: null,
      port: null,
      tlsMode: null,
      username: null,
      secret: { kind: null, isSet: false },
      revision: 0,
      status: "active",
      capabilities: { dsn: false, size: false, maxMessageBytes: null },
      lastVerifiedAt: null,
      lastError: null,
    },
    authenticationPolicy: { automation: "mailbox" },
    sentFolderId: null,
    draftsFolderId: null,
    isDefault: true,
    status: "unverified",
    statusReason: "sent_folder_missing",
    pendingVerificationCommandId: null,
    createdAt: now,
    updatedAt: now,
  };
  const { MailConversationReader } = modules!;
  let opened = 0;
  const [canAdmin, setCanAdmin] = createSignal(true);
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        identities: [identity],
        get canAdmin() {
          return canAdmin();
        },
        onOpenDeliverySettings: () => {
          opened += 1;
        },
      }),
    dom.root,
  );
  try {
    const reply = async () => {
      const action = collectContextAwareCommands().find((command) => command.id.endsWith(".reply"))?.action;
      if (typeof action !== "function") throw new Error("The reader registers no Reply command");
      await action();
    };
    await waitFor(() => collectContextAwareCommands().some((command) => command.id.endsWith(".reply")));
    await reply();
    await waitFor(() => opened === 1);
    expect(String(confirm.mock.calls[0]?.[0])).toContain("Support: Sent folder missing.");
    expect(confirm.mock.calls[0]?.[1]).toMatchObject({ title: "This mailbox cannot send yet", confirmText: "Open sender settings" });

    setCanAdmin(false);
    await reply();
    await waitFor(() => error.mock.calls.length === 1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Sent folder missing");
    expect(String(error.mock.calls[0]?.[0])).toContain("Manage access");
    expect(opened).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    confirm.mockRestore();
    error.mockRestore();
    dom.cleanup();
  }
});

test.skipIf(isServer)("changing the conversation during the seed-store import drops the stale reply", async () => {
  const dom = createDomTestHarness();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
  const reload = await import("@k2b/cloud/browser/reload");
  const nav = await import("@k2b/ssr/nav");
  const store = await import("./mail-draft-seed-store");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let imported = false;
  const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
    await pending;
    const module = await loader();
    imported = true;
    return module;
  });
  const navigate = spyOn(nav, "documentNavigate").mockImplementation(() => {});
  const storing = spyOn(store, "storeMailDraftSeed").mockImplementation(() => {});
  const identity: SenderIdentity = {
    id: "Send01",
    mailboxId: "Box001",
    label: "Support",
    displayName: "Support",
    fromAddress: "support@example.com",
    replyTo: null,
    defaultCc: [],
    defaultBcc: [],
    defaultFormat: "markdown",
    defaultPriority: "normal",
    defaultDeliveryReceipt: false,
    defaultReadReceipt: false,
    vcard: null,
    envelopeSender: null,
    defaultSignatureTemplateId: null,
    transport: {
      mode: "mailbox",
      host: null,
      port: null,
      tlsMode: null,
      username: null,
      secret: { kind: null, isSet: false },
      revision: 0,
      status: "active",
      capabilities: { dsn: false, size: false, maxMessageBytes: null },
      lastVerifiedAt: null,
      lastError: null,
    },
    authenticationPolicy: { automation: "mailbox" },
    sentFolderId: null,
    draftsFolderId: null,
    isDefault: true,
    status: "verified",
    statusReason: null,
    pendingVerificationCommandId: null,
    createdAt: now,
    updatedAt: now,
  };
  const seed: MailDraftSeed = {
    id: "20000000-0000-4000-8000-000000000002",
    mailboxId: "Box001",
    conversationId: "Conv01",
    intent: "reply",
    sourceMessageId: "Msg001",
    derivedFromMessageId: null,
    derivationKind: null,
    content: {
      senderIdentityId: "Send01",
      to: [],
      cc: [],
      bcc: [],
      subject: "Re: Quarterly review",
      body: "",
      format: "markdown",
      priority: "normal",
      requestDeliveryReceipt: false,
      requestReadReceipt: false,
    },
    attachments: [],
    origin: { kind: "compose", input: { senderIdentityId: "Send01", to: [], cc: [], bcc: [], subject: "Re: Quarterly review", body: "" } },
    createdAt: now,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === "POST" ? seed : []),
    { preconnect: originalFetch.preconnect },
  );
  const [conversationId, setConversationId] = createSignal("Conv01");
  const { MailConversationReader } = modules!;
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        identities: [identity],
        get selectionKey() {
          return conversationId();
        },
        get selectedConversationId() {
          return conversationId();
        },
        get messages() {
          return [
            { ...envelopeOnly, id: conversationId() === "Conv01" ? "Msg001" : "Msg002", hydrationStatus: "complete", plainText: "Hello" },
          ];
        },
      }),
    dom.root,
  );
  try {
    await waitFor(() => collectContextAwareCommands().some((command) => command.id.endsWith(".reply")));
    const action = collectContextAwareCommands().find((command) => command.id.endsWith(".reply"))?.action;
    if (typeof action !== "function") throw new Error("The reader registers no Reply command");
    await action();
    await waitFor(() => load.mock.calls.length === 1);
    expect(storing).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    setConversationId("Conv02");
    release();
    await waitFor(() => imported);
    await Bun.sleep(0);
    expect(storing).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    release();
    dispose();
    globalThis.fetch = originalFetch;
    load.mockRestore();
    navigate.mockRestore();
    storing.mockRestore();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    dom.cleanup();
  }
});

test.skipIf(isServer)("under Automatic the HTML frame stays mounted while the theme changes light to dark and back", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const both: MessageDetail = {
    ...envelopeOnly,
    hydrationStatus: "complete",
    contentType: "multipart/alternative",
    plainText: "Plain numbers.",
    sanitizedHtml: "<p>HTML numbers.</p>",
  };
  const [theme, setTheme] = createSignal<"light" | "dark" | null>(null);
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        messages: [both],
        get theme() {
          return theme();
        },
      }),
    dom.root,
  );
  try {
    const variant = (format: "html" | "plain") =>
      dom.root.querySelector<HTMLElement>(`[data-mail-message-id="Msg001"] [data-mail-body-format="${format}"]`);
    await waitFor(() => variant("html") !== null);
    const html = variant("html");
    const frame = html?.querySelector("iframe");
    expect(frame).not.toBeNull();
    for (const next of ["light", "dark", "light"] as const) {
      setTheme(next);
      await Bun.sleep(5);
      expect(variant("html")).toBe(html);
      expect(variant("html")?.querySelector("iframe")).toBe(frame);
      expect(variant("html")?.className).toBe("contents");
      expect(variant("plain")).toBeNull();
    }
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("queued actions keep triage available while structure controls wait", () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        canWrite: true,
        actionPending: false,
        structurePending: true,
        toolbarActions: ["trash", "keep", "tags"],
      }),
    dom.root,
  );
  try {
    const button = (label: string) => dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button("Move to Trash")?.disabled).toBe(false);
    expect(button("Keep")?.disabled).toBe(true);
    expect(button("Tags")?.disabled).toBe(true);
    const menuItem = (label: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
    expect(menuItem("Move to Trash")?.disabled).toBe(false);
    expect(menuItem("Keep")?.disabled).toBe(true);
    expect(menuItem("Tags")?.disabled).toBe(true);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("message display actions toggle colors on the same frame and keep the format override", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const [theme, setTheme] = createSignal<"light" | "dark">("dark");
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        messages: [{ ...envelopeOnly, hydrationStatus: "complete", plainText: "Plain message", sanitizedHtml: "<p>HTML message</p>" }],
        get theme() {
          return theme();
        },
      }),
    dom.root,
  );
  try {
    const card = () => dom.root.querySelector('[data-mail-message-id="Msg001"]')!;
    const action = (label: string) =>
      [...card().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
    const frame = card().querySelector("iframe")!;
    const source = frame.getAttribute("srcdoc");
    await waitFor(() => action("Show original colors") !== undefined);
    action("Show original colors")!.click();
    await waitFor(() => action("Adapt colors to dark mode") !== undefined);
    expect(card().querySelector("iframe")).toBe(frame);
    expect(frame.classList.contains("bg-white")).toBe(true);
    expect(frame.getAttribute("srcdoc")).toBe(source);
    action("Adapt colors to dark mode")!.click();
    await waitFor(() => action("Show original colors") !== undefined);
    expect(card().querySelector("iframe")).toBe(frame);
    expect(frame.classList.contains("bg-transparent")).toBe(true);
    expect(frame.getAttribute("srcdoc")).toBe(source);
    action("View as plain text")!.click();
    await waitFor(() => card().querySelector('[data-mail-body-format="plain"]') !== null);
    expect(card().querySelector("iframe")).toBeNull();
    expect(action("Show original colors")).toBeUndefined();
    setTheme("light");
    await Bun.sleep(5);
    expect(card().querySelector('[data-mail-body-format="plain"]')).not.toBeNull();
    action("View as HTML")!.click();
    await waitFor(() => card().querySelector("iframe") !== null);
    expect(card().querySelectorAll("[data-mail-body-format]")).toHaveLength(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("printing uses original HTML colors and restores dark mode afterward", async () => {
  const dom = createDomTestHarness();
  const { MailConversationReader } = modules!;
  const print = spyOn(window, "print").mockImplementation(() => {});
  const dispose = render(
    () =>
      createComponent(MailConversationReader, {
        ...readerProps,
        theme: "dark",
        readingFormat: "automatic",
        messages: [{ ...envelopeOnly, hydrationStatus: "complete", plainText: "", sanitizedHtml: "<p>HTML message</p>" }],
      }),
    dom.root,
  );
  try {
    const frame = dom.root.querySelector("iframe")!;
    expect(frame.classList.contains("bg-transparent")).toBe(true);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="More conversation actions"]')!.click();
    const printAction = () =>
      [...dom.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Print conversation",
      );
    await waitFor(() => printAction() !== undefined);
    printAction()!.click();
    await waitFor(() => print.mock.calls.length === 1);
    expect(frame.classList.contains("bg-white")).toBe(true);
    expect(frame.classList.contains("bg-transparent")).toBe(false);
    window.dispatchEvent(new Event("afterprint"));
    await waitFor(() => frame.classList.contains("bg-transparent"));
    expect(frame.classList.contains("bg-white")).toBe(false);
    expect(dom.root.querySelector("iframe")).toBe(frame);
  } finally {
    dispose();
    print.mockRestore();
    dom.cleanup();
  }
});
