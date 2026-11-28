import type { ApprovalPage, PendingApproval } from "../contracts/approvals";

/** Invented requests for the v2 list's tests: a normal page, and the worst case a person can meet. */
export const approvalItem = (id: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm",
  sentence: "Mail: Send the offer",
  review: {
    locale: "en",
    sentence: { action: "Send the offer", running: "Sending the offer", done: "Offer sent", confirm: "Send offer", decline: "Don't run" },
    slots: {},
    ask: "sends",
    view: {
      version: 1,
      blocks: [
        {
          kind: "Detail",
          title: "Details",
          items: [
            { label: "To", value: "customer@example.com" },
            { label: "Body", value: "Hello, please find our offer for maintenance and support attached." },
          ],
        },
      ],
    },
  },
  requester: { kind: "chat", appId: "assistant", title: "Offer Q4 for the customer", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: "2026-10-11T08:00:00.000Z",
  expiresAt: "2026-10-12T08:00:00.000Z",
  ...overrides,
});

/** Two apps, three requests, one that can be remembered for its chat. */
export const approvalsPage: ApprovalPage = {
  items: [
    approvalItem("1"),
    approvalItem("2", { assurance: "standard", remember: { chat: true, always: true, website: false } }),
    approvalItem("3", {
      app: { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" },
      action: "task.delete",
      sentence: "Spaces: Delete the task",
      review: {
        locale: "en",
        sentence: { action: "Delete the task", running: "Deleting", done: "Task deleted", confirm: "Delete task", decline: "Don't run" },
        slots: {},
        ask: "app_asks",
      },
    }),
  ],
  nextCursor: null,
  count: 3,
  elsewhere: 0,
};

const long = "Angebot für Wartung, Support und Rufbereitschaft der Donaudampfschifffahrtsgesellschaftskapitänsmütze 2027 🚢";

/** The worst case (break-ui): long and unbreakable names, emoji, a missing chat title, a large count, and more pages. */
export const worstCasePage: ApprovalPage = {
  items: [
    approvalItem("11", {
      app: { id: "verylongapplicationidentifier", name: "Kundenbeziehungsmanagementwerkzeugkasten", icon: "ti ti-building-store" },
      sentence: `Kundenbeziehungsmanagementwerkzeugkasten: ${long}`,
      review: {
        locale: "en",
        sentence: { action: long, running: "Sending", done: "Sent", confirm: `Send ${long}`, decline: "Don't run" },
        slots: {},
        ask: "sends",
      },
      requester: { kind: "chat", appId: "assistant", title: "x".repeat(140), href: "/app/assistant?conversation=chat2" },
    }),
    approvalItem("12", { requester: { kind: "chat", appId: "assistant", title: null, href: "/app/assistant?conversation=chat3" } }),
    approvalItem("13", {
      app: { id: "ä", name: "Ä", icon: "" },
      sentence: "Ä: 削除する",
      review: null,
      requester: { kind: "code_version", appId: "core", title: "Bericht", href: "/code/bericht/" },
      canApprove: false,
    }),
  ],
  nextCursor: "cursor-2",
  count: 12_345,
  elsewhere: 99_999,
};
