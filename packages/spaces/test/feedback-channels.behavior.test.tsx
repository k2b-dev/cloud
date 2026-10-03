import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { ToastOptions } from "@k2b/ui";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { SpaceItem } from "../src/contracts";
import type { ItemFormData } from "../src/frontend/[id]/_components/shared/ItemForm";

const now = "2026-10-03T10:00:00.000Z";
const item: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Book the venue",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: "user",
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
};
const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
};

let completionAnswers: Response[] = [];
const completions: unknown[] = [];
let createAnswers: Response[] = [];
const creations: Array<{ spaceId: string; title: unknown }> = [];
const commentAnswer = () => Response.json({ message: "Comments are closed for this item" }, { status: 409 });

describe("Spaces feedback channels", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  // One document for the file: Solid delegates events to the document that was current when a module loaded.
  const dom = createDomTestHarness();
  afterAll(() => dom.cleanup());
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          $post: async ({ param, json }: { param: { id: string }; json: { title?: unknown } }) => {
            creations.push({ spaceId: param.id, title: json.title });
            return createAnswers.shift() ?? Response.json({ ...item, spaceId: param.id, title: json.title });
          },
          [":itemId"]: {
            completed: {
              $post: async ({ json }: { json: unknown }) => {
                completions.push(json);
                return completionAnswers.shift() ?? Response.json({ ok: true });
              },
            },
            comments: { $post: async () => commentAnswer() },
          },
        },
      },
    },
  }));

  test("a ticked item confirms itself, and a failed tick offers Retry instead of an error dialog", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const notices: Array<{ message: string; options?: ToastOptions; dismissed: boolean }> = [];
    const errors = spyOn(toast, "error").mockImplementation((message, options) => {
      const notice = { message, options, dismissed: false };
      notices.push(notice);
      const dismiss = () => {
        notice.dismissed = true;
      };
      return { dismiss, update: () => {} };
    });
    const { default: ItemRow } = await import("../src/frontend/[id]/_components/list/ItemRow");
    const dispose = render(
      () =>
        createComponent(ItemRow, {
          item,
          spaceId: item.spaceId,
          columns: [],
          tags: [],
          isSelected: false,
          baseUrl: "/app/spaces/Space1",
          canWrite: true,
        }),
      dom.root,
    );
    const tick = () => dom.root.querySelector<HTMLButtonElement>('button[aria-label="Mark complete"]')!;

    completions.length = 0;
    completionAnswers = [Response.json({ message: "Spaces is unavailable" }, { status: 503 })];
    tick().click();
    await flush();
    expect(dialogs).not.toHaveBeenCalled();
    expect(notices.map((notice) => notice.message)).toEqual(["Spaces is unavailable"]);
    const action = notices[0]!.options?.action;
    expect(action?.label).toBe("Retry");

    if (!action || !("onClick" in action)) throw new Error("The error toast has no Retry callback");
    action.onClick();
    await flush();
    expect(notices[0]!.dismissed).toBe(true);
    expect(completions).toEqual([{ completed: true }, { completed: true }]);
    expect(notices).toHaveLength(1);
    expect(successes).not.toHaveBeenCalled();

    dispose();
    dialogs.mockRestore();
    successes.mockRestore();
    errors.mockRestore();
  });

  test("Retry of a failed create keeps the Space it was written for and returns to where the command came from", async () => {
    const { dialogCore, toast } = await import("@k2b/ui");
    const { createItemController } = await import("../src/frontend/[id]/_components/sidebar/CreateItemButton");
    const draft: ItemFormData = { columnId: "Col001", title: "Order name labels" };
    const form = spyOn(dialogCore, "open").mockResolvedValue(draft);
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const notices: Array<{ message: string; options?: ToastOptions }> = [];
    const errors = spyOn(toast, "error").mockImplementation((message, options) => {
      notices.push({ message, options });
      return { dismiss: () => {}, update: () => {} };
    });
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    let spaceId = "SpaceA";
    let controller: ReturnType<typeof createItemController> | undefined;
    const dispose = render(() => {
      controller = createItemController({
        get spaceId() {
          return spaceId;
        },
        columns: [],
        tags: [],
      });
      return null;
    }, dom.root);

    creations.length = 0;
    createAnswers = [Response.json({ message: "Spaces is unavailable" }, { status: 503 })];
    await controller!.createItem({ returnTo: "/app/mail/inbox" });
    expect(assign).not.toHaveBeenCalled();
    const action = notices[0]?.options?.action;
    if (!action || !("onClick" in action)) throw new Error("The error toast has no Retry callback");

    // A later compose command selects another Space before the user retries.
    spaceId = "SpaceB";
    action.onClick();
    await flush();
    expect(creations).toEqual([
      { spaceId: "SpaceA", title: "Order name labels" },
      { spaceId: "SpaceA", title: "Order name labels" },
    ]);
    expect(assign).toHaveBeenCalledWith("/app/mail/inbox");

    dispose();
    form.mockRestore();
    successes.mockRestore();
    errors.mockRestore();
    assign.mockRestore();
  });

  test("a Retry toast closes with its component, and a failure after it is gone shows none", async () => {
    const { toast } = await import("@k2b/ui");
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
    const { createRetryToasts } = await import("../src/frontend/lib/feedback");
    try {
      const [retryToast, dispose] = createRoot((dispose) => [createRetryToasts(), dispose] as const);
      for (let failure = 0; failure < 5; failure++) retryToast("The list could not be refreshed", "Retry", () => {});
      expect(notices.filter((notice) => notice.dismissed)).toHaveLength(0);
      dispose();
      // The rail closed the two oldest itself; the component keeps and closes only the three that can still be open.
      expect(notices.map((notice) => notice.dismissed)).toEqual([false, false, true, true, true]);
      retryToast("The list could not be refreshed", "Retry", () => {});
      expect(notices).toHaveLength(5);
    } finally {
      errors.mockRestore();
    }
  });

  test("a rejected comment stays in the composer with the reason under it", async () => {
    const { prompts, toast } = await import("@k2b/ui");
    const dialogs = spyOn(prompts, "error").mockResolvedValue(undefined);
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const { default: CommentsSection } = await import("../src/frontend/[id]/_components/detail/CommentsSection");
    const dispose = render(
      () =>
        createComponent(CommentsSection, {
          spaceId: item.spaceId,
          itemId: item.id,
          recurrenceId: null,
          comments: [],
          total: 0,
          loading: false,
          hasMore: false,
          loadingMore: false,
          onLoadMore: () => {},
          onRetry: () => {},
          currentUserId: "user",
          onUpdate: () => {},
          canWrite: true,
        }),
      dom.root,
    );
    const composer = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "Can we move this to Friday?";
    composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 20 && !dom.root.querySelector(".k2b-discussion__status"); attempt++) await flush();

    const alerts = [...dom.root.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).filter(Boolean);
    expect(alerts).toEqual(["Comments are closed for this item"]);
    expect(composer.value).toBe("Can we move this to Friday?");
    expect(dialogs).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();

    dispose();
    dialogs.mockRestore();
    errors.mockRestore();
  });
});
