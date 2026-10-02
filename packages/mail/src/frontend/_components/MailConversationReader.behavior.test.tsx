import { expect, test } from "bun:test";
import { type ComponentProps, createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageDetail } from "../../service/messages";
import type MailConversationReaderComponent from "./MailConversationReader";

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
  identities: [],
  selectionKey: "Conv01",
  selectedConversationId: "Conv01",
  selectedMessageId: null,
  unread: false,
  flagged: false,
  inJunk: false,
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
  onAction: () => undefined,
  onOpenHref: () => undefined,
  onManageTags: () => undefined,
  onMergeConversation: () => undefined,
  onReassignMessage: () => undefined,
  onSplitMessage: () => undefined,
  onSummarySaved: async () => undefined,
  onReconcile: async () => undefined,
  onReconcileAfterWrite: async () => undefined,
  onClose: () => undefined,
};

test.skipIf(isServer)(
  "the open reader replaces the pending body once hydration completes and offers a local refresh meanwhile",
  async () => {
    const dom = createDomTestHarness();
    const { default: MailConversationReader } = await import("./MailConversationReader");
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
  const { default: MailConversationReader } = await import("./MailConversationReader");
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
  const { default: MailConversationReader } = await import("./MailConversationReader");
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
  const { default: MailConversationReader } = await import("./MailConversationReader");
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
