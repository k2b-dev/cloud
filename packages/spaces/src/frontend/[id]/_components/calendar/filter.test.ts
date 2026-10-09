import { describe, expect, test } from "bun:test";
import { defaultCalendarFilter, parseCalendarFilter, parseCalendarRoute, writeCalendarFilter } from "./filter";

describe("calendar URL filters", () => {
  test("uses defaults for absent or malformed values", () => {
    expect(parseCalendarFilter(new URL("https://cloud.test/app/spaces/1?ctype=nope&cpriority=urgent,nope&ccolor=rainbow"))).toEqual(
      defaultCalendarFilter,
    );
  });

  test("round-trips supported filters without unrelated query changes", () => {
    const url = new URL("https://cloud.test/app/spaces/1?view=calendar&item=abc&ctags=stale");
    const filter = {
      type: "event" as const,
      assignedTo: "me" as const,
      priorities: ["urgent", "high"] as Array<"urgent" | "high">,
      columnIds: ["todo"],
      tagIds: ["ops"],
      colorBy: "person" as const,
    };

    writeCalendarFilter(url, filter);

    expect(parseCalendarFilter(url)).toEqual(filter);
    expect(url.searchParams.get("view")).toBe("calendar");
    expect(url.searchParams.get("item")).toBe("abc");
    expect(url.searchParams.get("ccolor")).toBe("person");
  });

  test("removes default values from generated URLs", () => {
    const url = new URL("https://cloud.test/app/spaces/1?ctype=event&cassigned=me&cpriority=high&ccolumns=todo&ctags=ops&ccolor=status");
    writeCalendarFilter(url, defaultCalendarFilter);
    expect(url.search).toBe("");
  });

  test("parses a safe optimistic route state", () => {
    const route = parseCalendarRoute(new URL("https://cloud.test/app/spaces/1?view=calendar&cv=week&cd=2026-09-18&ctype=event"));

    expect(route).toEqual({
      view: "week",
      date: "2026-09-18T00:00:00.000Z",
      filter: { ...defaultCalendarFilter, type: "event" },
    });
  });

  test("uses calendar route defaults for invalid navigation parameters", () => {
    const route = parseCalendarRoute(new URL("https://cloud.test/app/spaces/1?view=calendar&cv=nope&cd=nope"));

    expect(route.view).toBe("month");
    expect(route.date).toMatch(/T00:00:00\.000Z$/);
    expect(route.filter).toEqual(defaultCalendarFilter);
  });
});
