import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SpaceItem } from "@/contracts";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const COLUMN_ID = "33333333-3333-4333-8333-333333333333";
const TAG_ID = "88888888-8888-4888-8888-888888888888";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const OVERRIDE_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_SPACE_ID = "66666666-6666-4666-8666-666666666666";
const SPACE_SHORT_ID = "Space1";
const COLUMN_SHORT_ID = "Col001";
const ITEM_SHORT_ID = "Item01";
const OVERRIDE_SHORT_ID = "Over01";
const COMMENT_SHORT_ID = "Com001";
const TAG_SHORT_ID = "Tag001";
const calls: string[] = [];
let permission = "read";
let itemSpaceId = SPACE_ID;
let listedCommentRecurrenceId: string | null | undefined;
let listedFilter: { tagIds?: string[]; columnIds?: string[] } | undefined;

const space = {
  id: SPACE_ID,
  name: "Delivery",
  description: null,
  color: "#3b82f6",
  icalToken: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const column = { id: COLUMN_ID, spaceId: SPACE_ID, name: "To Do", color: null, rank: "1024", isDone: false };
const tag = { id: TAG_ID, spaceId: SPACE_ID, name: "Release", color: "#0ea5e9" };
const item: SpaceItem = {
  id: ITEM_ID,
  spaceId: SPACE_ID,
  columnId: COLUMN_ID,
  title: "Ship SSR",
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
  createdBy: USER_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
let loadedItem = item;
let loadedOverride: SpaceItem | null = null;
const comment = {
  id: "55555555-5555-4555-8555-555555555555",
  itemId: ITEM_ID,
  recurrenceId: null,
  userId: USER_ID,
  userName: "Ada",
  userAvatarHash: null,
  content: "Ready",
  createdAt: "2026-01-01T01:00:00.000Z",
  updatedAt: "2026-01-01T01:00:00.000Z",
  canEdit: true,
  canDelete: true,
};

mock.module("@valentinkolb/cloud/services", () => ({
  logger: () => ({ warn: () => undefined }),
  weatherService: {
    location: { cookie: { name: "weather", parse: () => null } },
    forecast: {
      get: async () => {
        calls.push("weather.get");
        return null;
      },
    },
    ui: { getTablerIcon: () => "ti ti-cloud" },
  },
}));

mock.module("@/service/events", () => ({
  latestSpaceEventCursor: async () => {
    calls.push("cursor");
    return "7-1";
  },
}));

mock.module("@/service/public-resources", () => ({
  spacesPublicResources: {
    resolvePublicId: async (table: string, shortId: string) => (table === "items" && shortId === ITEM_SHORT_ID ? ITEM_ID : null),
    projectSpaces: async (items: Array<{ id: string }>) => items.map((value) => ({ ...value, id: SPACE_SHORT_ID })),
    projectColumns: async (items: Array<{ id: string; spaceId: string }>) =>
      items.map((value) => ({ ...value, id: COLUMN_SHORT_ID, spaceId: SPACE_SHORT_ID })),
    projectTags: async (items: Array<{ id: string; spaceId: string }>) =>
      items.map((value) => ({ ...value, id: TAG_SHORT_ID, spaceId: SPACE_SHORT_ID })),
    projectItems: async (items: SpaceItem[]) =>
      items.map((value) => ({
        ...value,
        id: value.id === OVERRIDE_ID ? OVERRIDE_SHORT_ID : ITEM_SHORT_ID,
        spaceId: SPACE_SHORT_ID,
        columnId: COLUMN_SHORT_ID,
        recurringEventId: value.recurringEventId ? ITEM_SHORT_ID : null,
      })),
    projectComments: async (items: Array<{ id: string; itemId: string }>) =>
      items.map((value) => ({ ...value, id: COMMENT_SHORT_ID, itemId: ITEM_SHORT_ID })),
    projectTaskDependencies: async (items: unknown[]) => items,
    projectTaskDependents: async (items: unknown[]) => items,
    projectWormholes: async (items: unknown[]) => items,
    projectCalendarItems: async (items: unknown[]) => items,
  },
}));

mock.module("@/service", () => ({
  spacesService: {
    space: {
      get: async () => {
        calls.push("space.get");
        return space;
      },
      getDetail: async () => {
        calls.push("space.getDetail");
        return { ...space, columns: [column], tags: [tag] };
      },
      permission: { get: async () => permission },
    },
    item: {
      listFiltered: async (params: { filter?: { tagIds?: string[]; columnIds?: string[] } }) => {
        listedFilter = params.filter;
        return { items: [item], total: 1, page: 1, pageSize: 50, totalPages: 1 };
      },
      get: async (params: { id: string }) => {
        calls.push("item.get");
        if (params.id === OVERRIDE_ID) return loadedOverride;
        return { ...loadedItem, spaceId: itemSpaceId };
      },
      getRecurringOverride: async () => loadedOverride,
      references: { list: async () => [] },
      attachments: { list: async () => [] },
      checklist: { list: async () => [] },
      dependencies: { list: async () => [], listBlocks: async () => [] },
      calendar: { list: async () => [] },
    },
    comment: {
      list: async (params: { recurrenceId?: string | null }) => {
        calls.push("comment.list");
        listedCommentRecurrenceId = params.recurrenceId;
        return { items: [comment], page: 1, perPage: 50, total: 1, hasNext: false };
      },
    },
    access: {
      list: async () => ({ items: [], page: 1, perPage: 0, total: 0, hasNext: false }),
      apiKeys: { list: async () => [] },
    },
    wormhole: {
      actorForUser: () => ({}),
      listUsable: async () => [],
      listConfigured: async () => ({ ok: true, data: [] }),
    },
  },
}));

const { loadSpaceItemDetail, loadSpacesViewSnapshot, loadSpacesWorkspaceState } = await import("./workspace-state");

beforeEach(() => {
  calls.splice(0);
  permission = "read";
  itemSpaceId = SPACE_ID;
  loadedItem = item;
  loadedOverride = null;
  listedCommentRecurrenceId = undefined;
  listedFilter = undefined;
});

describe("Spaces workspace SSR state", () => {
  test("captures the live cursor after authorization and before snapshot queries", async () => {
    const state = await loadSpacesWorkspaceState({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}`,
    });

    expect(state.kind).toBe("ok");
    expect(calls.indexOf("space.get")).toBeLessThan(calls.indexOf("cursor"));
    expect(calls.indexOf("cursor")).toBeLessThan(calls.indexOf("space.getDetail"));
    if (state.kind === "ok") expect(state.eventCursor).toBe("7-1");
  });

  test("includes the selected item and bounded comments page in a deep-link snapshot", async () => {
    const state = await loadSpacesWorkspaceState({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}?item=${ITEM_SHORT_ID}`,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.selectedItemDetail?.item.id).toBe(ITEM_SHORT_ID);
    expect(state.selectedItemDetail?.comments.items[0]?.id).toBe(COMMENT_SHORT_ID);
    expect(state.selectedItemDetail?.commentTarget).toEqual({ itemId: ITEM_SHORT_ID, recurrenceId: null });
    expect(state.selectedItemDetail?.recurringContext).toBeNull();
    expect(state.selectedItemDetail?.attachments).toEqual([]);
    expect(state.selectedItemDetail?.checklist).toEqual([]);
  });

  test("refreshes a view without loading item comments", async () => {
    const snapshot = await loadSpacesViewSnapshot({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}?item=${ITEM_SHORT_ID}`,
    });

    expect(snapshot.kind).toBe("list");
    expect(calls).not.toContain("comment.list");
  });

  test("resolves public filter IDs before querying and projects results back", async () => {
    const snapshot = await loadSpacesViewSnapshot({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}?tags=${TAG_SHORT_ID}&columns=${COLUMN_SHORT_ID}`,
    });

    expect(listedFilter).toMatchObject({ tagIds: [TAG_ID], columnIds: [COLUMN_ID] });
    expect(snapshot.kind).toBe("list");
    if (snapshot.kind === "list") expect(snapshot.itemsResult.items[0]?.id).toBe(ITEM_SHORT_ID);
  });

  test("does not block remote calendar ranges on unavailable forecast data", async () => {
    const snapshot = await loadSpacesViewSnapshot({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}?view=calendar&cv=week&cd=2099-01-01`,
    });

    expect(snapshot.kind).toBe("calendar");
    expect(calls).not.toContain("weather.get");
  });

  test("loads one generated occurrence with an occurrence-scoped comment target", async () => {
    const recurrenceId = "2026-07-17T09:00:00.000Z";
    loadedItem = {
      ...item,
      startsAt: "2026-07-01T09:00:00.000Z",
      endsAt: "2026-07-01T09:30:00.000Z",
      recurrence: {
        rrule: "FREQ=DAILY",
        dtstart: "2026-07-01T09:00:00.000Z",
        exdate: [],
      },
    };

    const state = await loadSpacesWorkspaceState({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}?view=calendar&item=${ITEM_SHORT_ID}&occurrence=${encodeURIComponent(recurrenceId)}`,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.selectedItemDetail?.recurringContext).toEqual({
      seriesItemId: ITEM_SHORT_ID,
      recurrenceId,
      startsAt: recurrenceId,
      endsAt: "2026-07-17T09:30:00.000Z",
      allDay: false,
      isOverride: false,
    });
    expect(state.selectedItemDetail?.commentTarget).toEqual({ itemId: ITEM_SHORT_ID, recurrenceId });
    expect(listedCommentRecurrenceId).toBe(recurrenceId);
  });

  test("resolves a stale series occurrence URL to its stored override", async () => {
    const recurrenceId = "2026-07-17T09:00:00.000Z";
    loadedItem = {
      ...item,
      startsAt: "2026-07-01T09:00:00.000Z",
      endsAt: "2026-07-01T09:30:00.000Z",
      recurrence: {
        rrule: "FREQ=DAILY",
        dtstart: "2026-07-01T09:00:00.000Z",
        exdate: [],
      },
    };
    loadedOverride = {
      ...loadedItem,
      id: OVERRIDE_ID,
      startsAt: "2026-07-17T11:00:00.000Z",
      endsAt: "2026-07-17T11:30:00.000Z",
      recurrence: null,
      recurringEventId: ITEM_ID,
      recurrenceId,
    };

    const detail = await loadSpaceItemDetail({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      itemId: ITEM_ID,
      occurrenceId: recurrenceId,
    });

    expect(detail.kind).toBe("ok");
    if (detail.kind !== "ok") return;
    expect(detail.detail.item.id).toBe(OVERRIDE_SHORT_ID);
    expect(detail.detail.recurringContext).toEqual({
      seriesItemId: ITEM_SHORT_ID,
      recurrenceId,
      startsAt: "2026-07-17T11:00:00.000Z",
      endsAt: "2026-07-17T11:30:00.000Z",
      allDay: false,
      isOverride: true,
    });
    expect(detail.detail.commentTarget).toEqual({ itemId: ITEM_SHORT_ID, recurrenceId });
  });

  test("fails closed before reading cursor or snapshot data", async () => {
    permission = "none";
    const state = await loadSpacesWorkspaceState({
      user: { id: USER_ID, roles: ["user"] },
      spaceId: SPACE_ID,
      spaceShortId: SPACE_SHORT_ID,
      href: `/app/spaces/${SPACE_SHORT_ID}`,
    });

    expect(state.kind).toBe("accessDenied");
    expect(calls).not.toContain("cursor");
    expect(calls).not.toContain("space.getDetail");
  });

  test("detail loading rejects missing access and cross-space item ids before comments", async () => {
    permission = "none";
    const denied = await loadSpaceItemDetail({ user: { id: USER_ID, roles: ["user"] }, spaceId: SPACE_ID, itemId: ITEM_ID });
    expect(denied.kind).toBe("accessDenied");
    expect(calls).not.toContain("item.get");

    calls.splice(0);
    permission = "read";
    itemSpaceId = OTHER_SPACE_ID;
    const mismatched = await loadSpaceItemDetail({ user: { id: USER_ID, roles: ["user"] }, spaceId: SPACE_ID, itemId: ITEM_ID });
    expect(mismatched.kind).toBe("notFound");
    expect(calls).toContain("item.get");
    expect(calls).not.toContain("comment.list");
  });
});
