import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { SpaceItemDetail } from "../src/frontend/[id]/_components/workspace/workspace-types";
import { installV2Globals } from "./v2-dom";

// The open item on v2 for people who may only read it, for a generated occurrence of a series, and for who has access,
// as main's detail render tests asked (v1's ItemDetailPanel tests): a reader sees the values and none of the controls
// that change them; an occurrence the series generated has no item-level controls even for a writer, only its own
// comments; who has access shows only to people with access of their own; Markdown info blocks render everywhere.

const now = "2026-08-09T10:00:00.000Z";
const userId = "33333333-3333-4333-8333-333333333333";
const task: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Planning review",
  description: ":::warning Before the release\nCheck the **migration**.\n:::",
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: "2026-08-12",
  deadlineAllDay: true,
  estimatedDurationMinutes: 90,
  activeBlockerCount: 1,
  priority: "high",
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: userId,
  createdAt: "2026-08-01T07:30:00.000Z",
  updatedAt: "2026-08-08T15:45:00.000Z",
  assignees: [{ id: userId, kind: "user", displayName: "Robin Example", avatarHash: null }],
  tags: [{ id: "Tag001", spaceId: "Space1", name: "Release", color: "#2563eb" }],
  claim: null,
  reactions: [{ emoji: "👍", count: 2, own: true, people: [{ kind: "user", id: "other", displayName: "Kim Example" }] }],
};
const detailOf = (item: Partial<SpaceItem> = {}, extra: Partial<SpaceItemDetail> = {}): SpaceItemDetail => ({
  item: { ...task, ...item },
  comments: {
    items: [
      {
        id: "Com001",
        itemId: task.id,
        recurrenceId: null,
        userId,
        userName: "Robin Example",
        userAvatarHash: null,
        content: ":::success\nApproved.\n:::",
        createdAt: now,
        updatedAt: now,
        canEdit: true,
        canDelete: true,
      },
    ],
    page: 1,
    perPage: 50,
    total: 1,
    hasNext: false,
  },
  commentTarget: { itemId: task.id, recurrenceId: null },
  recurringContext: null,
  references: [],
  links: [{ url: "https://example.org/release-notes", label: "Release notes", createdAt: now, preview: null }],
  attachments: [{ id: "File01", filename: "board.webp", mimeType: "image/webp", sizeBytes: 42_000, kind: "image", createdAt: now }],
  checklist: [{ id: "Chk001", label: "Write the notes", completed: false, createdAt: now, updatedAt: now }],
  blockedBy: [{ blocker: { id: "Blk001", spaceId: "Space1", title: "Freeze the branch", completedAt: null }, createdAt: now }],
  blocks: [],
  work: {
    claim: null,
    progress: { content: ":::info\nTests are running.\n:::", actor: { kind: "user", id: userId }, at: now },
    result: null,
  },
  ...extra,
});

type Mount = {
  canWrite: boolean;
  detail?: SpaceItemDetail;
  access?: Parameters<typeof import("./detail-pane").DetailPaneFixture>[0]["access"];
};
const mount = async (dom: DomTestHarness, options: Mount) => {
  const { DetailPaneFixture } = await import("./detail-pane");
  const detail = options.detail ?? detailOf();
  return render(
    () =>
      createComponent(DetailPaneFixture, {
        detail: () => detail,
        canWrite: options.canWrite,
        currentUserId: userId,
        tags: task.tags,
        access: options.access,
      }),
    dom.root,
  );
};
/** Every control of the detail by its name: buttons, links that act, fields, and the entries of its menus' triggers. */
const controls = (dom: DomTestHarness) =>
  [
    ...[...dom.root.querySelectorAll<HTMLElement>("button")].map(
      (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
    ),
    ...[...dom.root.querySelectorAll<HTMLElement>("input, textarea, [role=textbox]")].map(
      (field) => field.getAttribute("aria-label") ?? field.closest('[data-k2-part="Field"]')?.querySelector("label")?.textContent ?? "",
    ),
  ].filter(Boolean);
/** The controls that change the item, its parts, or its discussion: a writer has every one of them. */
const writes = [
  "Mark complete",
  "I'm on it",
  "Edit item",
  // The facts a writer changes in place: the due day, the people, the tags, the priority and the estimate.
  "Wed, Aug 12 · in 3 days",
  "Robin Example",
  "Release",
  "High",
  "1 h 30 min",
  "Add reaction",
  "Remove blocker Freeze the branch",
  "Edit description",
  "Subtask label",
  "Add subtask…",
  "Add link",
  "Link Cloud resource",
  "More actions for Release notes",
  "Add image or video",
  "Delete board.webp",
  "More actions for Robin Example",
  "Add comment",
  "Post comment",
];
const fresh = () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  installV2Globals(dom);
  return dom;
};

describe("Spaces detail for readers and occurrences", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  afterEach(() => setSystemTime());

  test("a reader sees the item's values as text and none of the controls a writer has", async () => {
    setSystemTime(new Date(now));
    const writer = fresh();
    const disposeWriter = await mount(writer, { canWrite: true });
    expect(controls(writer)).toEqual(expect.arrayContaining(writes));
    disposeWriter();
    writer.cleanup();

    const reader = fresh();
    const disposeReader = await mount(reader, { canWrite: false });
    for (const control of writes) expect({ control, shown: controls(reader).includes(control) }).toEqual({ control, shown: false });
    const text = reader.root.textContent ?? "";
    for (const value of ["Planning review", "Read only", "Release", "High", "Write the notes", "Freeze the branch", "Release notes"])
      expect(text).toContain(value);
    disposeReader();
    reader.cleanup();
  });

  test("an occurrence the series generated has no item-level controls even for a writer, only its own comments", async () => {
    setSystemTime(new Date(now));
    const event = { startsAt: "2026-08-10T10:00:00.000Z", endsAt: "2026-08-10T11:00:00.000Z", deadline: null, recurrence: "FREQ=WEEKLY" };
    const occurrence = {
      seriesItemId: task.id,
      recurrenceId: "2026-08-10T10:00:00.000Z",
      startsAt: "2026-08-10T10:00:00.000Z",
      endsAt: "2026-08-10T11:00:00.000Z",
      allDay: false,
      isOverride: false,
    };
    const itemControls = ["Edit item", "Edit description", "Add reaction", "Add link", "Link Cloud resource"];
    const itemWrites = ["Edit item", "Duplicate item", "Save as template", "Delete item"];
    const itemMenu = async (dom: DomTestHarness) => {
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="More item actions"]')?.click();
      await Bun.sleep(10);
      const menu = [...dom.document.querySelectorAll('[role="menu"][data-open]')].at(-1);
      const labels = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((entry) => entry.textContent?.trim() ?? "");
      // An entry ends in its key, such as "E" for Edit item.
      return itemWrites.filter((write) => labels.some((label) => label.startsWith(write)));
    };

    // The series itself is the writer's to change.
    const series = fresh();
    const disposeSeries = await mount(series, { canWrite: true, detail: detailOf(event) });
    expect(controls(series)).toEqual(expect.arrayContaining(itemControls));
    expect(await itemMenu(series)).toEqual(itemWrites);
    disposeSeries();
    series.cleanup();

    const generated = fresh();
    const disposeGenerated = await mount(generated, {
      canWrite: true,
      detail: detailOf(event, { recurringContext: occurrence, commentTarget: { itemId: task.id, recurrenceId: occurrence.recurrenceId } }),
    });
    for (const control of itemControls)
      expect({ control, shown: controls(generated).includes(control) }).toEqual({ control, shown: false });
    expect(await itemMenu(generated)).toEqual([]);
    // No reactions of its own: not even the ones of the series show.
    expect(generated.root.querySelector('[aria-label^="👍"]')).toBeNull();
    const text = generated.root.textContent ?? "";
    expect(text).toContain("This occurrence");
    expect(text).toContain("View series");
    expect(text).toContain("Occurrence comments");
    expect(controls(generated)).toEqual(expect.arrayContaining(["Add comment", "Post comment"]));
    disposeGenerated();
    generated.cleanup();

    // A changed occurrence is stored on its own and has its own reactions.
    const override = fresh();
    const disposeOverride = await mount(override, {
      canWrite: true,
      detail: detailOf(event, { recurringContext: { ...occurrence, isOverride: true } }),
    });
    expect(controls(override)).toEqual(expect.arrayContaining(["Add reaction"]));
    expect(override.root.querySelector('[aria-pressed="true"][aria-label^="👍"]')).not.toBeNull();
    disposeOverride();
    override.cleanup();
  });

  test("who has access shows only to people with access of their own; while it loads or fails it keeps its place", async () => {
    const section = (dom: DomTestHarness) =>
      [...dom.root.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].find((entry) =>
        entry.textContent?.includes("Who has access"),
      );
    // A public link or public access alone reads the item, never who else may.
    const publicReader = fresh();
    const disposePublic = await mount(publicReader, { canWrite: false, access: null });
    expect(section(publicReader)).toBeUndefined();
    expect(publicReader.root.textContent).not.toContain("Who has access");
    disposePublic();
    publicReader.cleanup();

    const members = [
      { principal: { type: "user" as const, userId }, permission: "admin" as const, displayName: "Robin Example" },
      {
        principal: { type: "group" as const, groupId: "44444444-4444-4444-8444-444444444444" },
        permission: "write" as const,
        displayName: "Ops",
      },
    ];
    const member = fresh();
    const disposeMember = await mount(member, { canWrite: false, access: { members, state: "ready", retry: () => undefined } });
    expect(section(member)?.textContent).toContain("Applies to the whole space.");
    expect(section(member)?.textContent).toContain("Ops");
    disposeMember();
    member.cleanup();

    const loading = fresh();
    const disposeLoading = await mount(loading, { canWrite: false, access: { members: [], state: "loading", retry: () => undefined } });
    expect(section(loading)?.querySelector('[data-k2-part="Loading"]')).not.toBeNull();
    disposeLoading();
    loading.cleanup();

    let retried = 0;
    const failed = fresh();
    const disposeFailed = await mount(failed, { canWrite: false, access: { members: [], state: "error", retry: () => retried++ } });
    expect(section(failed)?.textContent).toContain("Could not load who has access");
    [...(section(failed)?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === "Retry")
      ?.click();
    expect(retried).toBe(1);
    disposeFailed();
    failed.cleanup();
  });

  test("info blocks render in the description, the comments and the work progress like every Markdown view", async () => {
    const { renderMarkdownInfoBlock } = await import("@k2b/ui");
    const dom = fresh();
    const dispose = await mount(dom, { canWrite: false });
    const html = dom.root.innerHTML;
    expect(html).toContain(
      renderMarkdownInfoBlock({
        type: "warning",
        title: "Before the release",
        bodyHtml: "<p>Check the <strong>migration</strong>.</p>\n",
        locale: "en",
      }),
    );
    expect(html).toContain(renderMarkdownInfoBlock({ type: "success", bodyHtml: "<p>Approved.</p>\n", locale: "en" }));
    expect(html).toContain(renderMarkdownInfoBlock({ type: "info", bodyHtml: "<p>Tests are running.</p>\n", locale: "en" }));
    expect(dom.root.textContent).not.toContain(":::");
    dispose();
    dom.cleanup();
  });

  test("the item names when it was created and last changed, quietly under More about, with its ID to copy", async () => {
    const { dates } = await import("@k2b/stdlib");
    const dom = fresh();
    const dispose = await mount(dom, { canWrite: false });
    const more = [...dom.root.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].find((entry) =>
      entry.textContent?.startsWith("More about this task"),
    );
    const facts = [...(more?.querySelectorAll(".k2-fact-pair") ?? [])].map((pair) => [
      pair.querySelector("dt")?.textContent,
      pair.querySelector("dd")?.textContent,
    ]);
    expect(facts).toEqual([
      ["Created", dates.formatDateTime(task.createdAt)],
      ["Updated", dates.formatDateTime(task.updatedAt)],
      ["ID", expect.stringContaining("Item01")],
    ]);
    expect(controls(dom)).toContain("Copy: ID");
    dispose();
    dom.cleanup();
  });
});
