import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import { fieldControl, installV2Globals } from "./v2-dom";

// The open task offers "Change due date" in the command palette, as on main: it asks for the day and an optional
// time and saves them, or removes the due date.

const now = "2026-10-15T08:00:00.000Z";
const userId = "33333333-3333-4333-8333-333333333333";
const task: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Count stock on shelf B",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: userId,
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
  claim: null,
};

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await Bun.sleep(20);
};
const commands = () => {
  const found = { commands: [] as { id: string; title: string; action: unknown }[] };
  window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail: found }));
  return found.commands;
};

describe("Spaces detail due date command", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  afterEach(() => setSystemTime());

  test("Change due date asks for the day and saves it", async () => {
    setSystemTime(new Date(now));
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installV2Globals(dom);
    delegateEvents(["click", "input"], dom.document);
    const patches: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(input).endsWith("/items/Item01")) {
        patches.push(JSON.parse(String(init.body)));
        return Response.json({ ...task, deadline: "2026-10-20", deadlineAllDay: true });
      }
      return Response.json({ data: [], nextCursor: null });
    }) as typeof globalThis.fetch);
    const { DetailPaneFixture } = await import("./detail-pane");
    const detail = {
      item: task,
      comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
      commentTarget: { itemId: task.id, recurrenceId: null },
      recurringContext: null,
      references: [],
      links: [],
      attachments: [],
      checklist: [],
      blockedBy: [],
      blocks: [],
    };
    const dispose = render(
      () => createComponent(DetailPaneFixture, { detail: () => detail, canWrite: true, currentUserId: userId }),
      dom.root,
    );
    try {
      const command = commands().find((entry) => entry.id === "spaces.Item01.deadline");
      expect(command?.title).toBe("Change due date");
      await (command!.action as () => Promise<void>)();
      await settle();
      const dialog = [...dom.document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
      expect(dialog?.textContent).toContain("Date");
      // The v2 date field takes a typed day when it is left.
      const day = fieldControl(dom, "Date")!;
      day.value = "2026-10-20";
      day.dispatchEvent(new Event("input", { bubbles: true }));
      day.dispatchEvent(new Event("change", { bubbles: true }));
      [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save")!.click();
      await settle();
      expect(patches).toEqual([{ deadline: "2026-10-20" }]);
    } finally {
      dispose();
      fetch.mockRestore();
      await Bun.sleep(20);
      dom.cleanup();
    }
  });
});
