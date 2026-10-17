import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { SpaceItem, SpaceItemReaction } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

// Write responses carry no reactions (the item contract), so a card that takes a write response keeps the summary it has.
const USER_ID = "77777777-7777-4777-8777-777777777777";
const reacted: SpaceItem = {
  id: "Item04",
  spaceId: "Space1",
  columnId: "Col001",
  title: "Reacted",
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
  createdBy: null,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  assignees: [],
  tags: [],
  reactions: [{ emoji: "👍", count: 1, own: false, people: [] }],
};
const calls: string[] = [];
/** Column reads wait until the test answers them with a page. */
const waitingReads: ((items: SpaceItem[]) => void)[] = [];
const answerReads = (items: SpaceItem[]) => {
  for (const answer of waitingReads.splice(0)) answer(items);
};
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const waitingReactions: ((reactions: SpaceItemReaction[]) => void)[] = [];
const react =
  (method: "PUT" | "DELETE") =>
  ({ param }: { param: { itemId: string } }) =>
    new Promise<Response>((resolve) => {
      calls.push(`${method}:${param.itemId}`);
      waitingReactions.push((reactions) => resolve(response({ reactions })));
    });

if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          // Column reloads wait, so the test sees what the write response left on the board.
          filter: {
            $post: () =>
              new Promise<Response>((resolve) =>
                waitingReads.push((items) => resolve(response({ items, page: 1, pageSize: 30, totalPages: 1, total: items.length }))),
              ),
          },
          [":itemId"]: {
            reactions: { ":emoji": { $put: react("PUT"), $delete: react("DELETE") } },
            move: {
              $post: async ({ param, json }: { param: { itemId: string }; json: { columnId: string } }) => {
                calls.push(`move:${param.itemId}`);
                const { reactions: _reactions, ...written } = reacted;
                return response({ ...written, columnId: json.columnId });
              },
            },
            $patch: async ({ param }: { param: { itemId: string } }) => {
              calls.push(`assign:${param.itemId}`);
              const { reactions: _reactions, ...written } = reacted;
              return response({ ...written, assignees: [{ id: USER_ID, kind: "user", displayName: "Valentin", avatarHash: null }] });
            },
          },
        },
      },
    },
  }));
}

const key = (target: EventTarget, value: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("Spaces Kanban write responses", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test.each([
    { action: "assign", newerRead: false },
    { action: "move", newerRead: false },
    { action: "move", newerRead: true },
  ])("a card keeps its reactions after $action when a column reload omits it (newer read: $newerRead)", async ({ action, newerRead }) => {
    calls.length = 0;
    const dom = createDomTestHarness();
    // The board gives the focus back after a keyboard drop through CSS.escape, which Happy DOM keeps on its window.
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    delegateEvents(["click", "focusin", "focusout"], dom.document);
    dom.root.className = "k2b-ui";
    const { default: KanbanBoard } = await import("../src/frontend/[id]/_components/kanban/KanbanBoard");
    const { defaultFilter } = await import("../src/frontend/[id]/_components/filter/types");
    const { attachCommandShortcuts } = await import("../../cloud/src/browser/command-shortcuts");
    const { runContextAwareCommand } = await import("@k2b/cloud/browser/commands");
    const { invalidateSpacesData } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    const stopKeyboard = attachCommandShortcuts((command) => void runContextAwareCommand(command));
    const dispose = render(
      () =>
        createComponent(KanbanBoard, {
          spaceId: "Space1",
          baseUrl: "/app/spaces/Space1?view=kanban",
          columns: [
            { id: "Col001", spaceId: "Space1", name: "Open", color: null, rank: "1024", isDone: false },
            { id: "Col002", spaceId: "Space1", name: "Later", color: null, rank: "2048", isDone: false },
          ],
          tags: [],
          filter: defaultFilter,
          folded: new Set<string>(),
          onToggleFolded: () => undefined,
          selectedItemId: "",
          initialBuckets: [
            {
              key: "column:Col001",
              label: "Open",
              color: null,
              kind: "column",
              columnId: "Col001",
              isDone: false,
              items: [reacted],
              page: 1,
              totalPages: 1,
              total: 1,
            },
            {
              key: "column:Col002",
              label: "Later",
              color: null,
              kind: "column",
              columnId: "Col002",
              isDone: false,
              items: [],
              page: 1,
              totalPages: 1,
              total: 0,
            },
          ],
          pageSize: 30,
          canWrite: true,
          currentUserId: USER_ID,
          wormholes: [],
        }),
      dom.root,
    );
    try {
      if (newerRead) {
        const chipNow = () => dom.root.querySelector<HTMLButtonElement>('[data-reaction-key="👍"]');
        chipNow()!.click();
        expect(calls).toEqual(["PUT:Item04"]);
        const saved = { ...reacted, reactions: [{ emoji: "👍", count: 2, own: true, people: [] }] };
        waitingReactions.shift()!(saved.reactions);
        await flush();
        // The reaction reload probes the columns before reading their pages.
        expect(waitingReads).toHaveLength(2);
        answerReads([saved]);
        await flush();
        expect(waitingReads).toHaveLength(2);
        answerReads([saved]);
        await flush();
        expect(chipNow()?.textContent).toBe("👍2");
        expect(chipNow()?.getAttribute("aria-pressed")).toBe("true");

        // Another tab removed the person's reaction; this read must retire the older write answer.
        const coverage = invalidateSpacesData(["view"]);
        await flush();
        expect(waitingReads).toHaveLength(2);
        answerReads([reacted]);
        await coverage;
        expect(chipNow()?.textContent).toBe("👍1");
        expect(chipNow()?.getAttribute("aria-pressed")).toBe("false");
      }
      const priorCalls = newerRead ? ["PUT:Item04"] : [];
      const board = dom.root.querySelector<HTMLElement>('[role="region"][aria-label="Kanban"]')!;
      board.focus();
      key(board, "ArrowDown");
      expect((dom.document.activeElement as HTMLElement).dataset.itemId).toBe("Item04");
      await flush();
      if (action === "assign") key(dom.document.activeElement!, "m");
      else {
        const grip = dom.root.querySelector<HTMLElement>('[data-spaces-kanban-grip="Item04"]')!;
        grip.focus();
        key(grip, " ");
        key(grip, "ArrowRight");
        key(grip, " ");
      }
      await flush();
      expect(calls).toEqual([...priorCalls, `${action}:Item04`]);
      const article = dom.root.querySelector('article:has([data-item-id="Item04"])')!;
      // The write response leaves out reactions; the initial column read still has them.
      expect(article.querySelector('[data-reaction-key="👍"]')).not.toBeNull();
      expect(waitingReads).toHaveLength(2);
      answerReads([]);
      await flush();
      // No loaded page contains the card now, but its board copy keeps the last known chips.
      const chipNow = () => dom.root.querySelector<HTMLButtonElement>('article:has([data-item-id="Item04"]) [data-reaction-key="👍"]');
      expect(dom.root.querySelector('[data-item-id="Item04"]')).not.toBeNull();
      expect(chipNow()?.textContent).toBe("👍1");
      expect(chipNow()?.getAttribute("aria-pressed")).toBe("false");
      chipNow()!.click();
      expect(calls).toEqual([...priorCalls, `${action}:Item04`, "PUT:Item04"]);
      waitingReactions.shift()!([{ emoji: "👍", count: 2, own: true, people: [] }]);
      await flush();
      expect(waitingReads).toHaveLength(2);
      answerReads([]);
      await flush();
      expect(chipNow()?.textContent).toBe("👍2");
      expect(chipNow()?.getAttribute("aria-pressed")).toBe("true");
      chipNow()!.click();
      expect(calls).toEqual([...priorCalls, `${action}:Item04`, "PUT:Item04", "DELETE:Item04"]);
      waitingReactions.shift()!(reacted.reactions!);
      await flush();
      expect(waitingReads).toHaveLength(2);
      answerReads([]);
      await flush();
      expect(chipNow()?.textContent).toBe("👍1");
      expect(chipNow()?.getAttribute("aria-pressed")).toBe("false");
      // A column that holds the card wins over the last DELETE answer.
      const coverage = invalidateSpacesData(["view"]);
      await flush();
      expect(waitingReads).toHaveLength(2);
      answerReads([{ ...reacted, reactions: [{ emoji: "👍", count: 2, own: true, people: [] }] }]);
      await coverage;
      const chip = chipNow();
      expect(chip?.getAttribute("aria-pressed")).toBe("true");
      expect(chip?.textContent).toBe("👍2");
      // A later read that leaves the card out keeps that newer read, not the board copy or an older answer.
      const omitted = invalidateSpacesData(["view"]);
      await flush();
      expect(waitingReads).toHaveLength(2);
      answerReads([]);
      await omitted;
      expect(chipNow()?.textContent).toBe("👍2");
      expect(chipNow()?.getAttribute("aria-pressed")).toBe("true");
      chipNow()!.click();
      expect(calls.at(-1)).toBe("DELETE:Item04");
    } finally {
      for (const answer of waitingReactions.splice(0)) answer(reacted.reactions!);
      await flush();
      answerReads([]);
      await flush();
      stopKeyboard();
      dispose();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
      dom.cleanup();
    }
  });
});
