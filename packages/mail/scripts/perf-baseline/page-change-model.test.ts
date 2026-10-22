import { expect, test } from "bun:test";
import { timeMetrics } from "./browser-model";
import { exampleResult } from "./example-result";
import { parseArgs, parsePrevious, renderSummary } from "./model";
import { type PageChanges, pageChangeSampleSchema, requireWarmCache } from "./page-change-model";

const section = (): PageChanges => ({
  gates: { desktopMs: 203, phoneMs: 821, panelChanges: 20 },
  profiles: [],
  sequence: { status: "skipped", reason: "not measured", snapshots: [], first20PanelReloads: 0, first20DocumentLoads: 0 },
});

test("warm measurement refuses a missing script graph, missing entry, or network transfer", () => {
  const url = "https://localhost:4100/assets/mail.js";
  expect(requireWarmCache([{ name: url, transferSize: 0 }], [url])).toBe(0);
  expect(() => requireWarmCache([], [])).toThrow("no eager JavaScript");
  expect(() => requireWarmCache([], [url])).toThrow("missing eager script");
  expect(() => requireWarmCache([{ name: url, transferSize: 300 }], [url])).toThrow("transferred bytes");
  expect(() =>
    requireWarmCache(
      [
        { name: url, transferSize: 0 },
        { name: url, transferSize: 1 },
      ],
      [url],
    ),
  ).toThrow("transferred bytes");
});

test("comparison migrates validated schema 1 and never invents page-change evidence", () => {
  const old = { ...exampleResult(), schemaVersion: 1 };
  const migrated = parsePrevious(old);
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.scenarios).toEqual(old.scenarios);
  expect(migrated.browser).toBeNull();
  const current = {
    ...exampleResult(),
    browser: {
      engines: [],
      versions: {},
      playwrightVersion: "test",
      runs: 1,
      pages: [],
      interactions: [],
      errors: [],
      pageChanges: section(),
    },
  };
  expect(parsePrevious(current).browser?.pageChanges).toEqual(section());
  expect(() => parsePrevious({ ...current, schemaVersion: 1 })).toThrow("Schema 1 cannot carry");
  expect(() => parsePrevious({ ...old, metadata: {} })).toThrow();
  expect(() => parsePrevious({ ...old, schemaVersion: 3 })).toThrow();
  expect(() => parsePrevious({ ...old, kind: "page" })).toThrow("Mail result");
});

test("page changes require a browser and preserve failures and fixed gates in the report", () => {
  expect(() => parseArgs(["--page-changes"])).toThrow("requires --browser");
  expect(parseArgs(["--page-changes", "--browser", "chromium", "--interactions", "none", "--loads", "none"])).toMatchObject({
    pageChanges: true,
    interactions: [],
    loads: [],
  });
  const pageChanges = section();
  pageChanges.profiles.push({
    id: "overview-mailbox",
    browser: "webkit",
    profile: "phone",
    cache: "warm",
    status: "failed",
    reason: "cache transferred",
    samples: [],
  });
  const result = exampleResult();
  result.browser = {
    engines: ["webkit"],
    versions: {},
    playwrightVersion: "test",
    runs: 1,
    pages: [],
    interactions: [],
    errors: [],
    pageChanges,
  };
  const summary = renderSummary(result);
  expect(summary).toContain("203 ms desktop / 821 ms phone");
  expect(summary).toContain("406 / 1,642 ms");
  expect(summary).toContain("failed: cache transferred");
  expect(summary).toContain("cannot establish swap cleanup");
});

test("page-change sample rejects nonfinite durations and records phone panel as unavailable", () => {
  const sample = {
    clickToMainMs: 100,
    clickToFirstActionMs: 150,
    documentLoad: true,
    panelReloaded: null,
    panelContextMs: null,
    panelStatus: "unavailable-phone" as const,
    htmlBytes: 100,
    jsBytes: 0,
    cssBytes: 0,
    eagerJsTransferBytes: 0,
  };
  expect(pageChangeSampleSchema.parse(sample)).toEqual(sample);
  for (const clickToMainMs of [-1, Infinity, NaN])
    expect(pageChangeSampleSchema.safeParse({ ...sample, clickToMainMs }).success).toBe(false);
});

test("ranking includes only measured page-change times and never fills absent evidence", () => {
  const result = exampleResult();
  const pageChanges = section();
  const sample = pageChangeSampleSchema.parse({
    clickToMainMs: 100,
    clickToFirstActionMs: 150,
    documentLoad: true,
    panelReloaded: null,
    panelContextMs: null,
    panelStatus: "unavailable-phone",
    htmlBytes: 100,
    jsBytes: 0,
    cssBytes: 0,
    eagerJsTransferBytes: 0,
  });
  pageChanges.profiles.push({
    id: "overview-mailbox",
    browser: "chromium",
    profile: "phone",
    cache: "warm",
    status: "ok",
    reason: null,
    samples: [sample],
  });
  result.browser = {
    engines: ["chromium"],
    versions: {},
    playwrightVersion: "test",
    runs: 1,
    pages: [],
    interactions: [],
    errors: [],
    pageChanges,
  };
  const key = "pageChange.overview-mailbox.chromium.phone.warm";
  expect(timeMetrics(result).get(`${key}.clickToFirstActionMs`)).toBe(150);
  expect(timeMetrics(result).has(`${key}.panelContextMs`)).toBe(false);
  pageChanges.profiles[0]!.status = "failed";
  expect(timeMetrics(result).has(`${key}.clickToFirstActionMs`)).toBe(false);
});
