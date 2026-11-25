import { describe, expect, test } from "bun:test";
import { legacyDeliveriesHref, legacyJobsHref } from "./legacy";
import { kindsOf, parseRunRef, parseRunsAddress, runsHref, runsQuery } from "./query";

const query = runsQuery("de", [
  { id: "mail", label: "Mail" },
  { id: "files", label: "Dateien" },
]);
const read = (search: string) => parseRunsAddress(query, new URLSearchParams(search));

describe("the runs address", () => {
  test("an empty address shows every kind of the last 24 hours, newest first, on the runs tab", () => {
    const address = read("");
    expect(kindsOf(address.state)).toEqual(["job", "workflow", "delivery", "deadLetter"]);
    expect(address.state.filters.time).toEqual({ kind: "preset", preset: "last-24h" });
    expect(address).toMatchObject({ page: 1, run: null, tab: "runs", issues: [] });
  });

  test("filters, search, page, open run and tab read back into the same address", () => {
    const address = read("kind=job,delivery&status=failed&app=mail&time=last-7d&q=timeout&page=2&run=job:aa:bb&tab=schedules");
    expect(address.issues).toEqual([]);
    expect(address.state.filters).toMatchObject({ kind: ["job", "delivery"], status: "failed", app: "mail" });
    expect(address).toMatchObject({ page: 2, run: { kind: "job", id: "aa:bb" }, tab: "schedules" });
    expect(runsHref(query, address.state, { page: 2, run: address.run, tab: "schedules" })).toBe(
      "/admin/observability/runs?kind=job,delivery&status=failed&app=mail&time=last-7d&q=timeout&page=2&run=job:aa:bb&tab=schedules",
    );
  });

  test("bounds and unknown values are reported, never cut", () => {
    const address = read(`q=${"x".repeat(201)}&status=lost&page=0&run=nope`);
    expect(address.state.search).toBeUndefined();
    expect(address.state.filters.status).toBeUndefined();
    expect(address.issues.map((issue) => issue.param).sort()).toEqual(["q", "status"]);
    expect(address).toMatchObject({ page: 1, run: null });
  });

  test("a run reference names its kind and the kind's own key", () => {
    expect(parseRunRef("delivery:6f1c0d2e-0000-4000-8000-000000000001")).toEqual({
      kind: "delivery",
      id: "6f1c0d2e-0000-4000-8000-000000000001",
    });
    expect(parseRunRef("deadLetter:mail/queue/send/m-1")).toEqual({ kind: "deadLetter", id: "mail/queue/send/m-1" });
    expect(parseRunRef("schedule:x")).toBeNull();
    expect(parseRunRef(null)).toBeNull();
  });
});

describe("addresses of the Jobs and Deliveries pages", () => {
  // Every link into the old pages that other apps use, and each filter, lands on the same runs.
  const jobs: [string, string][] = [
    ["", "/admin/observability/runs?kind=job"],
    ["search=grids", "/admin/observability/runs?kind=job&q=grids"],
    ["search=auth%3A", "/admin/observability/runs?kind=job&q=auth:"],
    ["window=7d&health=failed", "/admin/observability/runs?kind=job&time=last-7d&status=failed"],
    ["window=24h&health=all&type=all&duration=all", "/admin/observability/runs?kind=job"],
    ["health=stuck&type=ai&duration=1000", "/admin/observability/runs?kind=job&status=running&category=ai&duration=1000"],
    ["source=mail%3Async&page=3&run=aa:bb", "/admin/observability/runs?kind=job&source=mail:sync&page=3&run=job:aa:bb"],
    ["job_action=accepted&job_message=ok&successPage=2", "/admin/observability/runs?kind=job"],
    ["window=2d", "/admin/observability/runs?kind=job&window=2d"],
  ];
  for (const [before, after] of jobs)
    test(`jobs ?${before} → ${after}`, () => expect(legacyJobsHref(new URLSearchParams(before))).toBe(after));

  const deliveries: [string, string | null][] = [
    ["", "/admin/observability/runs?kind=delivery"],
    [
      "view=deliveries&status=deferred&apps=mail,files&channels=email&search=rechnung&page=2",
      "/admin/observability/runs?kind=delivery&status=waiting&app=mail&apps=files&channel=email&q=rechnung&page=2",
    ],
    ["status=delivered", "/admin/observability/runs?kind=delivery&status=succeeded"],
    ["view=registry", null],
    ["view=legacy&search=x", null],
  ];
  for (const [before, after] of deliveries)
    test(`deliveries ?${before} → ${after ?? "stays"}`, () => expect(legacyDeliveriesHref(new URLSearchParams(before))).toBe(after));

  test("a carried-over parameter without a counterpart is named as not applied on the runs page", () => {
    const target = new URL(legacyJobsHref(new URLSearchParams("window=2d")), "https://cloud.test");
    expect(read(target.search.slice(1)).issues).toEqual([{ code: "unknown", param: "window", value: "2d" }]);
  });
});
