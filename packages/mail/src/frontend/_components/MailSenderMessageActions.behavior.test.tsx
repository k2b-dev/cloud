import { describe, expect, mock, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageDetail } from "../../service/messages";

/** The editor has its own tests; here only how often the menu opens it matters. */
const editorOpens: unknown[] = [];
mock.module("./MailIncomingAutomationSettings", () => ({
  openIncomingAutomationEditor: async (params: unknown) => void editorOpens.push(params),
}));

const now = "2026-09-24T10:00:00.000Z";

const message: MessageDetail = {
  id: "Msg001",
  subject: "Quarterly review",
  messageId: "<Msg001@example.test>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [{ name: "Recipient", address: "recipient@example.test" }],
  preview: null,
  hasAttachments: false,
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 128,
  replyTo: [],
  cc: [],
  plainText: "Hello",
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: null, domain: null },
  delivery: null,
  attachments: [],
};

describe("Mail sender message actions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("heads each section like the other action menus; the sender's actions live in the sender card", async () => {
    const dom = createDomTestHarness();
    const [{ default: MailSenderMessageActions }, { LocaleProvider }] = await Promise.all([
      import("./MailSenderMessageActions"),
      import("@k2b/ui"),
    ]);
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <MailSenderMessageActions
            mailboxId="Box001"
            requestUrl="http://localhost/app/mail/Box001/c/Conv01"
            canWrite={true}
            canAdmin={true}
            mailboxWide
            selectionKey="Conv01"
            selectedConversationId="Conv01"
            message={message}
            totalMessageCount={2}
            identities={[]}
            onReassignMessage={() => {}}
            onSplitMessage={() => {}}
            onDeriveMessage={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      dom.document.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")?.click();
      const sections = Array.from(dom.document.querySelectorAll("[role='group']")).map((group) => group.getAttribute("aria-label"));
      expect(sections).toEqual(["Conversation", "Other"]);
      const items = Array.from(dom.document.querySelectorAll("[role='menuitem']")).map((item) => item.textContent?.trim());
      expect(items).toContain("Report phishing");
      expect(items).toContain("Technical details");
      expect(items).not.toContain("Block sender");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("a sender automation opens one editor however often it is chosen while its code loads", async () => {
    const dom = createDomTestHarness();
    const [{ createMailMessageMenu }, { createRoot }] = await Promise.all([import("./MailSenderMessageActions"), import("solid-js")]);
    const { menu, dispose } = createRoot((dispose) => ({
      dispose,
      menu: createMailMessageMenu({
        mailboxId: "Box001",
        requestUrl: "http://localhost/app/mail/Box001/c/Conv01",
        canWrite: true,
        canAdmin: true,
        mailboxWide: true,
        selectionKey: "Conv01",
        selectedConversationId: "Conv01",
        message,
        totalMessageCount: 2,
        identities: [],
        onReassignMessage: () => {},
        onSplitMessage: () => {},
        onDeriveMessage: () => {},
      }),
    }));
    const choose = (id: string) => menu.senderActions().find((action) => action.id === id)!.action!();
    try {
      expect(menu.senderActions().map((action) => action.id)).toEqual(["find", "automation", "block", "block-domain"]);
      choose("automation");
      // The menu shows that the editor is on its way; a second choice meanwhile opens nothing more.
      expect(menu.automationLoading()).toBe(true);
      choose("block");
      for (let attempt = 0; attempt < 100 && menu.automationLoading(); attempt += 1) await Bun.sleep(5);
      expect(editorOpens).toEqual([expect.objectContaining({ mailboxId: "Box001", initialAction: "mark_read" })]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
