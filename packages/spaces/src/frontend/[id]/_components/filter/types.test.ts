import { describe, expect, test } from "bun:test";
import { buildFilterUrl, defaultFilter, hasActiveFilters, parseFilterFromUrl } from "./types";

describe("Spaces activity filter URL state", () => {
  test("round-trips inactive work and rejects unknown activity states", () => {
    const href = buildFilterUrl("/app/spaces/Space1", { activity: "inactive" }, defaultFilter);

    expect(href).toBe("/app/spaces/Space1?activity=inactive");
    expect(parseFilterFromUrl(new URL(href, "https://cloud.test")).activity).toBe("inactive");
    expect(hasActiveFilters(parseFilterFromUrl(new URL(href, "https://cloud.test")))).toBe(true);
    expect(parseFilterFromUrl(new URL("https://cloud.test/app/spaces/Space1?activity=unknown")).activity).toBe("all");
  });
});
