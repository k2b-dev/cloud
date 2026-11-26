import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { installV2Globals } from "./v2-dom";

const now = "2026-09-26T08:00:00.000Z";
const userId = "33333333-3333-4333-8333-333333333333";
const item: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Publish release",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 4,
  priority: "medium",
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

const _flush = async () => {
  // A v2 menu answers a choice after its close settles, a few frames later.
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
  await Bun.sleep(20);
};

const mount = async (
  dom: DomTestHarness,
  overrides: { canWrite?: boolean; activeBlockerCount?: number; item?: Partial<SpaceItem> } = {},
) => {
  const { DetailPaneFixture } = await import("./detail-pane");
  const blocker = (index: number) => ({
    blocker: { id: `Blk00${index}`, spaceId: item.spaceId, title: `Step ${index}`, completedAt: index === 0 ? now : null },
    createdAt: now,
  });
  const detail = {
    item: { ...item, activeBlockerCount: overrides.activeBlockerCount ?? item.activeBlockerCount, ...overrides.item },
    comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
    commentTarget: { itemId: item.id, recurrenceId: null },
    recurringContext: null,
    references: [],
    links: [],
    attachments: [],
    checklist: [],
    blockedBy: [0, 1, 2, 3, 4].map(blocker),
    blocks: [],
  };
  return render(
    () => createComponent(DetailPaneFixture, { detail: () => detail, canWrite: overrides.canWrite ?? true, currentUserId: userId }),
    dom.root,
  );
};

describe("Spaces detail planning rows", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("folds five blockers to three, open ones first, and unfolds them on request", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const dispose = await mount(dom, { canWrite: false });
    const titles = () =>
      Array.from(dom.root.querySelectorAll('section[aria-label="Blocked by"] .k2-row-title'), (title) => title.textContent);

    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    const toggle = Array.from(dom.root.querySelectorAll<HTMLButtonElement>('section[aria-label="Blocked by"] button')).find(
      (button) => button.textContent?.trim() === "2 more",
    )!;
    expect(toggle.textContent?.trim()).toBe("2 more");

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 0"]);
    expect(toggle.textContent?.trim()).toBe("Show fewer");
    // The toggle stays the same button below the list, so keyboard focus stays on it.
    expect(toggle.isConnected).toBe(true);

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    dispose();
    dom.cleanup();
  });

  test("counts blockers as the list row does, and names the ones the reader cannot open", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    // Four of the five listed blockers are open; the server counts six, two of them in a Space this reader cannot open.
    const dispose = await mount(dom, { canWrite: false, activeBlockerCount: 6 });
    const text = dom.root.textContent ?? "";
    expect(text).toContain("Blocked by 6");
    expect(text).not.toContain("Blocked by 4");
    expect(text).toContain("2 more blocking tasks you cannot open");
    dispose();
    dom.cleanup();
  });

  test("an editor sees empty tags, priority and estimate as places to set them; a reader sees no empty rows", async () => {
    const labels = (dom: DomTestHarness) => Array.from(dom.root.querySelectorAll(".k2-fact-pair > dt"), (label) => label.textContent);
    const empty = { priority: null, tags: [], estimatedDurationMinutes: null };
    const editor = createDomTestHarness();
    editor.root.className = "k2b-ui";
    const disposeEditor = await mount(editor, { item: empty });
    expect(labels(editor)).toEqual(expect.arrayContaining(["Tags", "Priority", "Estimate"]));
    disposeEditor();
    editor.cleanup();

    const reader = createDomTestHarness();
    reader.root.className = "k2b-ui";
    const disposeReader = await mount(reader, { canWrite: false, item: empty });
    expect(labels(reader)).not.toContain("Tags");
    expect(labels(reader)).not.toContain("Priority");
    expect(labels(reader)).not.toContain("Estimate");
    disposeReader();
    reader.cleanup();
  });

  test("an event names its people Participants, in the row and in the picker that changes them", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    // The picker is a popover: it needs the v2 globals the DOM harness leaves out.
    installV2Globals(dom);
    const dispose = await mount(dom, {
      item: { startsAt: "2026-09-28T09:00:00.000Z", endsAt: "2026-09-28T10:00:00.000Z", priority: null },
    });
    expect(Array.from(dom.root.querySelectorAll(".k2-fact-pair > dt"), (label) => label.textContent)).toContain("Participants");
    const picker = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2-fact-pair button")).find(
      (button) => button.textContent?.trim() === "Nobody",
    )!;
    picker.click();
    await _flush();
    const title = dom.document.querySelector('[data-k2-part="Popover"] .k2-pop-title');
    expect(title?.textContent).toBe("Participants");
    dispose();
    // The popover settles its focus after it leaves; the document stays until then.
    await _flush();
    dom.cleanup();
  });

  test("shows no hidden blockers when the reader can open every one", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const dispose = await mount(dom, { canWrite: false });
    expect(dom.root.textContent).toContain("Blocked by 4");
    expect(dom.root.textContent).not.toContain("cannot open");
    dispose();
    dom.cleanup();
  });
});
