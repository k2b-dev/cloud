import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageDetail } from "../../service/messages";

/** The inspector has its own tests; here only how often the panel opens it matters. */
const inspectorOpens: unknown[] = [];
mock.module("./MailMessageInspectorDialog", () => ({
  openMailMessageInspector: async (params: unknown) => void inspectorOpens.push(params),
}));

const panelProps = (messages: MessageDetail[]) => ({
  mailboxId: "Box001",
  conversationId: "Conv01",
  active: true,
  canWrite: true,
  mailboxWide: true,
  initialState: { conversationId: "Conv01", assignees: [], workStatus: "needs_action" as const, snoozedUntil: null, revision: 1 },
  initialLocalTags: [],
  initialConversationLocalTags: { conversationId: "Conv01", conversationRevision: 1, tags: [] },
  initialComments: [],
  initialCommentsCursor: null,
  assignableUsers: [],
  presence: [],
  activity: [],
  initialReminder: null,
  detailErrors: {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
    reference: null,
    summary: null,
    drafts: null,
  },
  conversationDrafts: [],
  messages,
  subject: "",
  requestUrl: "/app/mail/Box001?conversation=Conv01",
  dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
  onCollaborationChange: () => undefined,
  onConversationTagsChange: () => undefined,
  onClose: () => undefined,
  onOpenHref: () => undefined,
  onReconcile: () => undefined,
});

test.skipIf(isServer)("assign and reminder Commands name an untitled conversation instead of quoting an empty subject", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ items: [] }), { preconnect: originalFetch.preconnect });
  const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
  const { default: MailDetailsPanel } = await import("./MailDetailsPanel");
  const dispose = render(() => createComponent(MailDetailsPanel, panelProps([])), dom.root);
  try {
    const commands = () => collectContextAwareCommands().filter((command) => /\.(assign|reminder)$/.test(command.id));
    for (let i = 0; i < 100 && commands().length !== 2; i++) await Bun.sleep(10);
    expect(commands().map((command) => command.description)).toEqual([
      "Add or remove who handles “(No subject)”.",
      "Choose when to be reminded about “(No subject)”.",
    ]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test.skipIf(isServer)("the message inspector opens once however often its buttons are pressed while its code loads", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ items: [] }), { preconnect: originalFetch.preconnect });
  const at = "2026-10-01T10:00:00.000Z";
  const message: MessageDetail = {
    id: "Msg001",
    subject: "Quarterly review",
    messageId: "<Msg001@example.test>",
    internalDate: at,
    sentAt: at,
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
    sourceAvailable: false,
    mailingList: null,
    remoteContent: { imageIds: [], allowedByRule: false, sender: null, domain: null },
    delivery: null,
    attachments: [],
  };
  const { default: MailDetailsPanel } = await import("./MailDetailsPanel");
  const dispose = render(() => createComponent(MailDetailsPanel, panelProps([message])), dom.root);
  const button = (label: string) => {
    const element = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
    expect(element).toBeDefined();
    return element!;
  };
  try {
    const headers = button("Headers");
    headers.click();
    // The pressed button shows that the inspector is on its way and keeps focus for the inspector to return it.
    expect(headers.getAttribute("aria-busy")).toBe("true");
    expect(headers.disabled).toBe(false);
    headers.click();
    button("Source").click();
    for (let attempt = 0; attempt < 100 && headers.hasAttribute("aria-busy"); attempt += 1) await Bun.sleep(5);
    expect(inspectorOpens).toEqual([expect.objectContaining({ initialMessageId: "Msg001", initialTab: "headers" })]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
