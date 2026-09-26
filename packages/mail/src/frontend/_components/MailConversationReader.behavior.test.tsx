import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageDetail } from "../../service/messages";

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
          get messages() {
            return messages();
          },
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
          onReconcile: () => {
            refreshes += 1;
            return new Promise<void>((resolve) => {
              finishRefresh = resolve;
            });
          },
          onReconcileAfterWrite: async () => undefined,
          onClose: () => undefined,
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
