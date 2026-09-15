import { describe, expect, test } from "bun:test";
import { buildJobsFilterUrl, defaultJobsFilter, parseJobsFilterFromUrl } from "./types";

const baseUrl = "/admin/observability/jobs";

describe("job run navigation", () => {
  test.each(["0.5", "1.5", "0", "-2", "Infinity", "NaN", "9007199254740992"])("rejects invalid page %s", (page) => {
    expect(parseJobsFilterFromUrl(new URL(`http://cloud${baseUrl}?page=${page}`)).page).toBe(1);
  });

  test("opening a run preserves the current source, filters, and page", () => {
    const current = {
      ...defaultJobsFilter,
      window: "7d",
      health: "failed",
      search: "cleanup",
      source: "mail.cleanup",
      page: 3,
    } as const;
    const run = `${"a".repeat(32)}:${"b".repeat(16)}`;
    const url = buildJobsFilterUrl(baseUrl, { run }, current);

    expect(parseJobsFilterFromUrl(new URL(`http://cloud${url}`))).toEqual({ ...current, run });
  });

  test("closing a run removes only the run selection", () => {
    const current = {
      ...defaultJobsFilter,
      duration: "1000",
      type: "schedule",
      source: "mail.cleanup",
      run: `${"a".repeat(32)}:${"b".repeat(16)}`,
      page: 2,
    } as const;
    const url = buildJobsFilterUrl(baseUrl, { run: null }, current);

    expect(url).not.toContain("run=");
    expect(parseJobsFilterFromUrl(new URL(`http://cloud${url}`))).toEqual({ ...current, run: null });
  });
});
