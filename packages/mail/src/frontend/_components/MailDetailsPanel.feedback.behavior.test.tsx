import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ToastOptions } from "@k2b/ui";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { ConversationComment } from "../../service/collaboration";

const now = "2026-10-03T10:00:00.000Z";
const note: ConversationComment = {
  id: "Comm01",
  conversationId: "Conv01",
  body: "Call the customer back.",
  author: { kind: "user", id: "user-1", displayName: "Tom Sample", avatarHash: null },
  referencedMessageId: null,
  revision: 1,
  canEdit: true,
  canDelete: true,
  editedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};
const flush = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};

type Request = { method: string; path: string; body: unknown };
const requests: Request[] = [];
let answer: (request: Request) => Response = () => Response.json({ items: [] });

describe("Mail details feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const text = typeof init?.body === "string" ? init.body : "";
        const entry = { method: init?.method ?? "GET", path: url.pathname, body: text ? JSON.parse(text) : null };
        requests.push(entry);
        return answer(entry);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const renderPanel = async () => {
    const { default: MailDetailsPanel } = await import("./MailDetailsPanel");
    return render(
      () =>
        createComponent(MailDetailsPanel, {
          mailboxId: "Box001",
          conversationId: "Conv01",
          active: true,
          canWrite: true,
          initialState: { conversationId: "Conv01", assignee: null, workStatus: "needs_action", snoozedUntil: null, revision: 1 },
          initialLocalTags: [],
          initialConversationLocalTags: { conversationId: "Conv01", conversationRevision: 1, tags: [] },
          initialComments: [note],
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
          messages: [],
          subject: "Delivery date",
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
  };

  test("a rejected note stays in the composer with the reason under it", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    answer = (request) =>
      request.method === "POST" && request.path.endsWith("/comments")
        ? Response.json({ message: "This conversation is read-only" }, { status: 409 })
        : Response.json({ items: [] });
    const dispose = await renderPanel();
    try {
      const composer = dom.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add internal comment"]')!;
      composer.value = "Ask for the tracking number.";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let attempt = 0; attempt < 30 && !dom.root.querySelector(".k2b-discussion__status"); attempt++) await flush();

      expect(dom.root.querySelector(".k2b-discussion__status")?.textContent).toBe("This conversation is read-only");
      expect(composer.value).toBe("Ask for the tracking number.");
      expect(dialogs).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dispose();
      dialogs.mockRestore();
      errors.mockRestore();
    }
  });

  test("a failed note edit offers Retry with the edited text instead of an error dialog", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const form = spyOn(prompts, "form").mockResolvedValue({ body: "  Call the customer back on Monday.  " });
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const notices: Array<{ message: string; options?: ToastOptions; dismissed: boolean }> = [];
    const errors = spyOn(toast, "error").mockImplementation((message, options) => {
      const notice = { message, options, dismissed: false };
      notices.push(notice);
      return {
        dismiss: () => {
          notice.dismissed = true;
        },
        update: () => {},
      };
    });
    let failEdit = true;
    answer = (request) => {
      if (request.method !== "PATCH") return Response.json({ items: [] });
      if (failEdit) return Response.json({ message: "Mail is unavailable" }, { status: 503 });
      return Response.json({ ...note, body: "Call the customer back on Monday.", revision: 2 });
    };
    const dispose = await renderPanel();
    try {
      requests.length = 0;
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')!.click();
      for (let attempt = 0; attempt < 30 && notices.length === 0; attempt++) await flush();

      expect(dialogs).not.toHaveBeenCalled();
      expect(notices.map((notice) => notice.message)).toEqual(["Mail is unavailable"]);
      const action = notices[0]!.options?.action;
      if (!action || !("onClick" in action)) throw new Error("The error toast has no Retry callback");
      expect(action.label).toBe("Retry");

      failEdit = false;
      action.onClick();
      for (let attempt = 0; attempt < 30 && !dom.root.textContent?.includes("on Monday"); attempt++) await flush();

      expect(notices[0]!.dismissed).toBe(true);
      expect(form).toHaveBeenCalledTimes(1);
      const edits = requests.filter((request) => request.method === "PATCH");
      expect(edits).toEqual([
        {
          method: "PATCH",
          path: "/api/mail/mailboxes/Box001/conversations/Conv01/comments/Comm01",
          body: { expectedRevision: 1, body: "Call the customer back on Monday." },
        },
        {
          method: "PATCH",
          path: "/api/mail/mailboxes/Box001/conversations/Conv01/comments/Comm01",
          body: { expectedRevision: 1, body: "Call the customer back on Monday." },
        },
      ]);
      expect(dom.root.textContent).toContain("Call the customer back on Monday.");
      expect(successes).not.toHaveBeenCalled();
    } finally {
      dispose();
      dialogs.mockRestore();
      form.mockRestore();
      successes.mockRestore();
      errors.mockRestore();
    }
  });

  test("a failure that arrives after its component is gone shows no Retry toast", async () => {
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const { createRetryToasts } = await import("./mail-feedback");
    try {
      const [retryToast, dispose] = createRoot((dispose) => [createRetryToasts(), dispose] as const);
      dispose();
      retryToast("The invitation could not be refreshed", { retryLabel: "Retry", retry: () => {} });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test("a Retry toast closes with the panel, so it cannot write for a view that is gone", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const form = spyOn(prompts, "form").mockResolvedValue({ body: "Call the customer back on Monday." });
    const notices: Array<{ dismissed: boolean }> = [];
    const errors = spyOn(toast, "error").mockImplementation(() => {
      const notice = { dismissed: false };
      notices.push(notice);
      return {
        dismiss: () => {
          notice.dismissed = true;
        },
        update: () => {},
      };
    });
    answer = (request) =>
      request.method === "PATCH" ? Response.json({ message: "Mail is unavailable" }, { status: 503 }) : Response.json({ items: [] });
    const dispose = await renderPanel();
    try {
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')!.click();
      for (let attempt = 0; attempt < 30 && notices.length === 0; attempt++) await flush();
      expect(notices).toEqual([{ dismissed: false }]);

      dispose();
      expect(notices).toEqual([{ dismissed: true }]);
    } finally {
      form.mockRestore();
      errors.mockRestore();
    }
  });
});
