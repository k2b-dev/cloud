import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { decodeWorkCursor, EventAgendaDataSchema, EventAgendaInputSchema, TaskFocusInputSchema } from "./capability-work-contracts";
import { boundedWorkPage, runEventAgenda, runTaskFocus } from "./capability-work-queries";
import type { CalendarItem } from "./contracts";
import { spacesService } from "./service";
import { spacesPublicResources } from "./service/public-resources";

afterEach(() => mock.restore());
test("byte-limited work pages advance by the actual retained row count", () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, label: "\u0001".repeat(500), title: "\u0001".repeat(500) }));
  const result = boundedWorkPage(rows, 0, 100);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CAPABILITY_MAX_RESULT_BYTES);
  expect(result.data.length).toBeLessThan(100);
  expect(result.data.length).toBeGreaterThan(0);
  if (!result.page.hasMore) throw new Error("Expected continuation");
  expect(decodeWorkCursor(result.page.nextCursor)).toBe(result.data.length);
});
const context = {
  subject: { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" },
  spaceId: "33333333-3333-4333-8333-333333333333",
};
test("focus forwards filters and permission context before limiting the page", async () => {
  const search = spyOn(spacesService.item, "searchAcross").mockResolvedValue([]);
  spyOn(spacesPublicResources, "projectItems").mockResolvedValue([]);
  const result = await runTaskFocus(
    TaskFocusInputSchema.parse({ assignedTo: "me", activity: "inactive", blocked: true, deadlineFilter: "overdue", limit: 10 }),
    context,
  );
  expect(search).toHaveBeenCalledWith(
    expect.objectContaining({
      ...context,
      kinds: "task",
      status: "open",
      assignedTo: "me",
      activity: "inactive",
      blocked: true,
      deadlineFilter: "overdue",
      limit: 11,
      offset: 0,
    }),
  );
  expect(result).toEqual({ data: [], page: { hasMore: false } });
});
test("agenda retains series identity, occurrence deep links and pagination", async () => {
  const occurrence: CalendarItem = {
    id: "Item01:2026-01-01T09:00:00.000Z",
    spaceId: "Space1",
    spaceName: "Team",
    spaceColor: "#fff",
    title: "Daily",
    descriptionPreview: null,
    location: null,
    url: null,
    startsAt: "2026-01-01T09:00:00.000Z",
    endsAt: "2026-01-01T10:00:00.000Z",
    allDay: false,
    deadline: null,
    priority: null,
    recurrence: null,
    recurringEventId: "Item01",
    recurrenceId: "2026-01-01T09:00:00.000Z",
  };
  const list = spyOn(spacesService.item.calendar, "listSourcePage").mockResolvedValue({ items: [occurrence, occurrence] });
  spyOn(spacesPublicResources, "projectCalendarItems").mockResolvedValue([occurrence]);
  const result = await runEventAgenda(
    EventAgendaInputSchema.parse({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", limit: 1 }),
    context,
  );
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ ...context, from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }));
  expect(EventAgendaDataSchema.safeParse(result.data).success).toBe(true);
  expect(result.data[0]?.ref.id).toBe("Item01");
  expect(result.data[0]?.seriesId).toBe("Item01");
  expect(result.data[0]?.href).toContain("&occurrence=2026-01-01T09%3A00%3A00.000Z");
  expect(result.page.hasMore).toBe(true);
  expect(result.page.hasMore && result.page.nextCursor).toBeTruthy();
  if (!result.page.hasMore) throw new Error("Expected next occurrence page");
  await runEventAgenda(
    EventAgendaInputSchema.parse({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", limit: 1, cursor: result.page.nextCursor }),
    context,
  );
  expect(spacesPublicResources.projectCalendarItems).toHaveBeenLastCalledWith([occurrence]);
  await expect(
    runEventAgenda(
      EventAgendaInputSchema.parse({ from: "2026-01-01T00:00:00Z", to: "2026-01-03T00:00:00Z", cursor: result.page.nextCursor }),
      context,
    ),
  ).rejects.toThrow("Invalid agenda cursor");
});

test("agenda continues past a full batch of historical series with no occurrences", async () => {
  const rootId = "44444444-4444-4444-8444-444444444444";
  const list = spyOn(spacesService.item.calendar, "listSourcePage")
    .mockResolvedValueOnce({ items: [], nextRootId: rootId })
    .mockResolvedValueOnce({ items: [] });
  spyOn(spacesPublicResources, "projectCalendarItems").mockResolvedValue([]);
  const input = EventAgendaInputSchema.parse({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
  const first = await runEventAgenda(input, context);
  expect(first.data).toEqual([]);
  expect(first.page.hasMore).toBe(true);
  if (!first.page.hasMore) throw new Error("Expected source continuation");
  const second = await runEventAgenda({ ...input, cursor: first.page.nextCursor }, context);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ afterRootId: rootId }));
  expect(second.page.hasMore).toBe(false);
});
