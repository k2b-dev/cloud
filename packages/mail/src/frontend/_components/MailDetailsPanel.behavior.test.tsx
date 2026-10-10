import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

test.skipIf(isServer)("assign and reminder Commands name an untitled conversation instead of quoting an empty subject", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ items: [] }), { preconnect: originalFetch.preconnect });
  const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
  const { default: MailDetailsPanel } = await import("./MailDetailsPanel");
  const dispose = render(
    () =>
      createComponent(MailDetailsPanel, {
        mailboxId: "Box001",
        conversationId: "Conv01",
        active: true,
        canWrite: true,
        mailboxWide: true,
        initialState: { conversationId: "Conv01", assignees: [], workStatus: "needs_action", snoozedUntil: null, revision: 1 },
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
          keep: null,
          reference: null,
          summary: null,
          drafts: null,
        },
        conversationDrafts: [],
        messages: [],
        subject: "",
        requestUrl: "/app/mail/Box001?conversation=Conv01",
        dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
        onCollaborationChange: () => undefined,
        onConversationTagsChange: () => undefined,
        onClose: () => undefined,
        onOpenHref: () => undefined,
        onReconcile: () => undefined,
      }),
    dom.root,
  );
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
