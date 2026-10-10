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
  remoteContent: { imageIds: [], allowedByRule: false, sender: null, domain: null },
  delivery: null,
  attachments: [],
};

describe("Mail sender message actions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("heads each section like the other action menus", async () => {
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
      expect(sections).toEqual(["Sender", "Conversation"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("a sender automation opens one editor however often it is chosen while its code loads", async () => {
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
    const trigger = dom.document.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")!;
    const choose = (label: string) => {
      trigger.click();
      const item = Array.from(dom.document.querySelectorAll<HTMLElement>("[role='menuitem']")).find(
        (element) => element.textContent?.trim() === label,
      );
      expect(item).toBeDefined();
      item!.click();
    };
    try {
      choose("Create automation from sender");
      // The trigger shows that the editor is on its way and keeps focus for the editor to return it.
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(trigger.disabled).toBe(false);
      choose("Block sender");
      for (let attempt = 0; attempt < 100 && trigger.hasAttribute("aria-busy"); attempt += 1) await Bun.sleep(5);
      expect(editorOpens).toEqual([expect.objectContaining({ mailboxId: "Box001", initialAction: "mark_read" })]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
