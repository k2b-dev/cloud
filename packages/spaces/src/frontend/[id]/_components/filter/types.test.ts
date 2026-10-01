import { describe, expect, test } from "bun:test";
import { boardFilter, buildFilterUrl, defaultFilter, hasActiveFilters, parseFilterFromUrl } from "./types";

describe("Spaces Kanban filter URL state", () => {
  test("keeps only the filters a board can honor, so its links never carry list sorting or paging", () => {
    const url = new URL(
      "https://cloud.test/app/spaces/Space1?view=kanban&assignedTo=me&priority=urgent,high&tags=Tag001&deadline=week&q=launch&activity=claimed&status=all&columns=Col001&sort=title&groupBy=tag&page=3",
    );
    const filter = boardFilter(parseFilterFromUrl(url));

    expect(filter).toEqual({
      ...defaultFilter,
      assignedTo: "me",
      priority: ["urgent", "high"],
      tagIds: ["Tag001"],
      deadlineFilter: "week",
      search: "launch",
      activity: "claimed",
    });
    expect(buildFilterUrl("/app/spaces/Space1", {}, filter)).toBe(
      "/app/spaces/Space1?activity=claimed&priority=urgent%2Chigh&tags=Tag001&assignedTo=me&deadline=week&q=launch",
    );
    expect(hasActiveFilters(boardFilter(parseFilterFromUrl(new URL("https://cloud.test/app/spaces/Space1?status=all&sort=title"))))).toBe(
      false,
    );
  });
});

describe("Spaces activity filter URL state", () => {
  test("round-trips inactive work and rejects unknown activity states", () => {
    const href = buildFilterUrl("/app/spaces/Space1", { activity: "inactive" }, defaultFilter);

    expect(href).toBe("/app/spaces/Space1?activity=inactive");
    expect(parseFilterFromUrl(new URL(href, "https://cloud.test")).activity).toBe("inactive");
    expect(hasActiveFilters(parseFilterFromUrl(new URL(href, "https://cloud.test")))).toBe(true);
    expect(parseFilterFromUrl(new URL("https://cloud.test/app/spaces/Space1?activity=claimed")).activity).toBe("claimed");
    expect(parseFilterFromUrl(new URL("https://cloud.test/app/spaces/Space1?activity=unknown")).activity).toBe("all");
  });
});
