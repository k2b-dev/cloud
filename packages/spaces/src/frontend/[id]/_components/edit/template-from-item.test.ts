import { describe, expect, test } from "bun:test";
import type { SpaceItem } from "@/contracts";
import { templateFromItem } from "./template-from-item";

const dateConfig = { locale: "de", timeZone: "Europe/Berlin", firstDayOfWeek: 1 as const };
const lena = { id: "00000000-0000-4000-8000-000000000001", kind: "user" as const, displayName: "Lena H.", avatarHash: null };
const gone = { id: "00000000-0000-4000-8000-000000000002", kind: "user" as const, displayName: "Tom K.", avatarHash: null };
const task = {
  id: "Itm001",
  spaceId: "Space1",
  columnId: "Col001",
  title: "Wochenbericht KW 44",
  description: "Zahlen und Stand",
  priority: "medium",
  tags: [{ id: "Tag001", spaceId: "Space1", name: "Intern", color: "#16a34a" }],
  assignees: [lena, gone],
  // Friday 30 October 2026, 16:00 in Berlin.
  deadline: "2026-10-30T15:00:00.000Z",
  estimatedDurationMinutes: 30,
  startsAt: null,
  endsAt: null,
  allDay: false,
  location: null,
  url: null,
} as unknown as SpaceItem;
const checklist = ["Zahlen aus Grids holen", "Offene Reklamationen zählen", "Bericht an Team schicken"].map((label, index) => ({
  id: `Chk00${index}`,
  label,
  completed: index === 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}));

describe("saving an item as a template", () => {
  test("takes over the task's content, keeps the boxes unchecked, and only suggests the week and the weekday", () => {
    const { draft, suggestions } = templateFromItem(task, { checklist, assigneesWithAccess: new Set([lena.id]), dateConfig });
    expect(draft).toMatchObject({
      kind: "task",
      name: "Wochenbericht",
      title: "Wochenbericht KW 44",
      description: "Zahlen und Stand",
      priority: "medium",
      tags: task.tags,
      assignees: [lena],
      checklist: ["Zahlen aus Grids holen", "Offene Reklamationen zählen", "Bericht an Team schicken"],
      estimatedDurationMinutes: 30,
      timeOfDay: "16:00",
      dateRule: { type: "none" },
    });
    expect(suggestions).toEqual({
      title: { text: "KW 44", replacement: "KW {{week}}", token: "week" },
      weekday: "FR",
      fromItem: { dropped: ["Tom K."] },
    });
  });

  test("a date in the title is suggested as {{date}}, and a date-only deadline gives no time", () => {
    const { draft, suggestions } = templateFromItem({ ...task, title: "Wareneingang 2.11. prüfen", deadline: "2026-11-02" } as SpaceItem, {
      dateConfig,
    });
    expect(draft.name).toBe("Wareneingang prüfen");
    expect(draft.timeOfDay).toBeNull();
    expect(suggestions.title).toEqual({ text: "2.11.", replacement: "{{date}}", token: "date" });
    expect(suggestions.weekday).toBe("MO");
  });

  test("an event keeps its length, start time, place, and link; a multi-day event becomes one day", () => {
    const event = {
      ...task,
      title: "Kundentermin Weber",
      deadline: null,
      startsAt: "2026-11-03T09:00:00.000Z",
      endsAt: "2026-11-03T10:30:00.000Z",
      location: "Büro",
      url: "https://example.org/call",
    } as unknown as SpaceItem;
    const { draft } = templateFromItem(event, { dateConfig });
    expect(draft).toMatchObject({
      kind: "event",
      durationMinutes: 90,
      timeOfDay: "10:00",
      location: "Büro",
      url: "https://example.org/call",
      checklist: [],
    });
    const days = templateFromItem({ ...event, allDay: true, endsAt: "2026-11-05T23:00:00.000Z" } as SpaceItem, { dateConfig });
    expect(days.draft).toMatchObject({ allDay: true, durationMinutes: null, timeOfDay: null });
  });
});
