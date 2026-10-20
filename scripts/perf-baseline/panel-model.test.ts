import { expect, test } from "bun:test";
import { help } from "../perf-baseline";
import {
  aggregatePanel,
  dominantPanelSegment,
  medianPanelSample,
  type PanelNavigation,
  type PanelProfile,
  type PanelResult,
  type PanelSample,
  panelLayouts,
  panelNavigationIds,
  panelSampleSchema,
  panelSchema,
  panelSegments,
  panelSplit,
  panelVerdict,
  parseArgs,
  renderSummary,
  resultSchema,
} from "./model";
import { panelNavigations, panelViewports, providerHref } from "./panel";

function sample(lag = 100, open = 500, sheet = false): PanelSample {
  return {
    panelContentMs: sheet ? null : 1000 + lag,
    navigationGapMs: sheet ? null : 30,
    assignToContentMs: sheet ? null : 1030 + lag,
    openToContentMs: sheet ? open : null,
    hostTtiMs: 1000,
    hostLcpMs: null,
    panelLagMs: sheet ? null : lag,
    hostWaitMs: 100,
    frameStartMs: 50,
    providerSsrMs: 200,
    providerClientMs: (sheet ? open : 1000 + lag) - 350,
    providerReadyMs: 600,
    providerTtfbMs: 190,
    providerDocumentBytes: 1500,
    providerIslandRenderMs: 45,
    contentHeading: "view",
  };
}
function fixture(lag = 100, open = 500): PanelResult {
  const navigations: PanelNavigation[] = panelNavigationIds.map((id) => ({
    id,
    from: "/app/example",
    to: "/app/example/seed",
    crossApp: id === "spaces-to-mail",
    heading: id === "notebooks" ? "start" : "view",
    fromHeading: "start",
    status: "ok",
    errors: [],
    providerStatic: null,
    profiles: (["chromium", "webkit"] as const).flatMap((browser) =>
      panelLayouts.map((layout): PanelProfile => {
        const samples = [sample(lag, open, layout === "sheet")];
        return {
          browser,
          layout,
          viewport: panelViewports[layout],
          cpuThrottle: browser === "webkit" ? null : layout === "sheet" ? 4 : 1,
          network: null,
          status: "ok",
          reason: null,
          samples,
          aggregates: aggregatePanel(samples),
          dominantSegment: dominantPanelSegment(samples),
        };
      }),
    ),
  }));
  return { navigations, observations: [], verdict: panelVerdict({ navigations }) };
}
function row(panel: PanelResult, browser: PanelProfile["browser"], layout: PanelProfile["layout"]) {
  const result = panel.navigations.find((n) => n.id === "mail")?.profiles.find((r) => r.browser === browser && r.layout === layout);
  if (!result) throw new Error("Missing fixture profile");
  return result;
}
function replace(row: PanelProfile, value: PanelSample) {
  row.samples = [value];
  row.aggregates = aggregatePanel(row.samples);
}

const metadata = {
  commit: "fixture",
  dirty: true,
  timestamp: "2026-10-19T00:00:00Z",
  bunVersion: "1.4.2",
  playwrightVersion: "1.63.0",
  browserVersions: {},
  cpuCount: 4,
  loadAverage: { start: 1, end: 2 },
  runs: 3,
  origin: "https://localhost:4100",
  transport: "https-h2-caddy",
  runtimeImage: "fixture",
  seedVersion: 1,
};

test("--panel selects only the scenario, rejects conflicts before setup, and is documented in exported help", () => {
  expect(parseArgs(["--panel", "--runs", "5"])).toMatchObject({ panel: true, pages: [], runs: 5 });
  expect(parseArgs(["--panel"]).runs).toBe(3);
  for (const args of [
    ["--panel", "--pages", "spaces"],
    ["--pages", "mail-mailbox", "--panel"],
    ["--compare", "old.json", "--panel"],
  ])
    expect(() => parseArgs(args)).toThrow("--panel cannot");
  expect(help).toContain("--panel");
  expect(help).toContain("all eight");
});

test("schema 1 parses new panel fields and old results without a panel section", () => {
  const old = resultSchema.parse({ schemaVersion: 1, metadata, pages: [], errors: [] });
  expect(old.panel).toBeUndefined();
  const panel = fixture();
  panel.observations.push({ engine: "webkit", switch: "folder", panelReloaded: null, note: "unconnected mailbox" });
  expect(resultSchema.parse({ ...old, panel }).panel).toEqual(panel);
  expect(panelSchema.parse(panel).navigations).toHaveLength(4);
});

test("panel aggregates include signed lag and navigation gaps, nullable metrics and every timing field", () => {
  const samples = [sample(-200), sample(10), sample(100)];
  samples[0] = { ...sample(-200), navigationGapMs: -4 };
  const metrics = aggregatePanel(samples);
  expect(metrics.panelLagMs).toEqual({ median: 10, min: -200, max: 100 });
  expect(metrics.panelContentMs).toEqual({ median: 1010, min: 800, max: 1100 });
  expect(metrics.navigationGapMs).toEqual({ median: 30, min: -4, max: 30 });
  expect(metrics.openToContentMs).toBeNull();
  expect(metrics.providerDocumentBytes?.median).toBe(1500);
  expect(metrics.providerIslandRenderMs?.median).toBe(45);
  expect(metrics.providerReadyMs?.median).toBe(600);
});

test("median sample sorts by the main metric, takes the lower middle, and keeps a consecutive split", () => {
  const samples = [sample(800), sample(-100), sample(100), sample(200)];
  expect(medianPanelSample(samples, "drawer")).toBe(samples[2] ?? sample());
  expect(samples[0]?.panelLagMs).toBe(800);
  const sheets = [sample(100, 800, true), sample(100, 200, true), sample(100, 500, true)];
  expect(medianPanelSample(sheets, "sheet")).toBe(sheets[2] ?? sample());
  for (const anchor of [0, 120.7]) {
    const split = panelSplit(anchor, 200.3, 240.8, 390.4, 700.9);
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(Math.round(700.9) - Math.round(anchor));
    expect(split.frameStartMs).toBe(41);
  }
  // A script-inserted iframe starts navigating before the MutationObserver reports it: its start bounds the host wait.
  expect(panelSplit(0, 300, 210, 250, 700)).toEqual({ hostWaitMs: 210, frameStartMs: 0, providerSsrMs: 40, providerClientMs: 450 });
  expect(dominantPanelSegment([sample()])).toBe("providerClientMs");
  expect(dominantPanelSegment([])).toBeNull();
  expect(() => panelSampleSchema.parse({ ...sample(), hostWaitMs: 5000 })).toThrow("Panel split");
  for (const layout of panelLayouts) {
    const s = medianPanelSample(fixture().navigations[0]?.profiles.find((p) => p.layout === layout)?.samples ?? [], layout);
    expect(panelSegments.reduce((total, key) => total + s[key], 0)).toBe(s.panelContentMs ?? s.openToContentMs ?? -1);
  }
});

test("fast complete medians pass; only WebKit drawer exceeding desktop limit names the failing row", () => {
  const panel = fixture();
  expect(panelVerdict(panel)).toMatchObject({ verdict: "not slow", borderline: false, dominantSegment: "providerClientMs" });
  replace(row(panel, "webkit", "drawer"), sample(450));
  const verdict = panelVerdict(panel);
  expect(verdict.verdict).toBe("slow");
  expect(verdict.reasons).toEqual(["mail / webkit / drawer: median panelLagMs 450 ms > 400 ms"]);
  expect(verdict.desktopWorst).toMatchObject({ navigation: "mail", browser: "webkit", layout: "drawer", medianMs: 450 });
});

test("WebKit phone determines the phone verdict; throttled Chromium sheet is information only", () => {
  const panel = fixture();
  replace(row(panel, "chromium", "sheet"), sample(100, 20_000, true));
  expect(panelVerdict(panel).verdict).toBe("not slow");
  replace(row(panel, "webkit", "sheet"), sample(100, 1001, true));
  expect(panelVerdict(panel)).toMatchObject({ verdict: "slow", phoneWorst: { navigation: "mail", medianMs: 1001 } });
});

test("threshold equality passes and the inclusive ten-percent borderline bands cover both sides", () => {
  expect(panelVerdict(fixture(400, 1000))).toMatchObject({ verdict: "not slow", borderline: true });
  for (const lag of [360, 361, 400, 439, 440]) expect(panelVerdict(fixture(lag)).borderline).toBe(true);
  for (const lag of [359, 441]) expect(panelVerdict(fixture(lag)).borderline).toBe(false);
  for (const open of [900, 1000, 1100]) expect(panelVerdict(fixture(100, open)).borderline).toBe(true);
  for (const open of [899, 1101]) expect(panelVerdict(fixture(100, open)).borderline).toBe(false);
});

test("a failed, skipped or missing required profile makes the verdict incomplete and names it", () => {
  for (const status of ["failed", "skipped"] as const) {
    const panel = fixture();
    row(panel, "webkit", "drawer").status = status;
    expect(panelVerdict(panel).verdict).toBe("incomplete");
    expect(panelVerdict(panel).reasons.join(" ")).toContain(`mail / webkit / drawer: ${status}`);
  }
  const panel = fixture();
  const nav = panel.navigations.find((n) => n.id === "mail");
  if (!nav) throw new Error("Missing navigation");
  nav.profiles = [];
  expect(panelVerdict(panel).verdict).toBe("incomplete");
  expect(panelVerdict({ navigations: [] }).reasons).toHaveLength(20);
  const info = fixture();
  row(info, "chromium", "sheet").status = "failed";
  const mail = info.navigations.find((nav) => nav.id === "mail");
  if (mail) mail.status = "failed";
  expect(panelVerdict(info).verdict).toBe("not slow");
});

test("summary renders the verdict, profile tables, median-sample split, observations and failures", () => {
  const panel = fixture();
  row(panel, "chromium", "sheet").reason = "Sample timeout diagnostic";
  panel.observations.push({ engine: "webkit", switch: "view", panelReloaded: false, note: "Host and provider retained." });
  const result = resultSchema.parse({ schemaVersion: 1, metadata, pages: [], panel, errors: [] });
  const summary = renderSummary(result);
  expect(summary).toContain("## Panel after navigation");
  expect(summary).toContain("**not slow**");
  expect(summary).toContain("| webkit / drawer |");
  expect(summary).toContain("1100 (1100–1100)");
  expect(summary).toContain("providerClientMs: 750 (68%)");
  expect(summary).toContain("Sample timeout diagnostic");
  expect(summary).toContain("webkit view: panel preserved");
  expect(summary).toContain("3 warm navigation runs");
});

test("SSR provider URL is discovered without a provider path assumption and rejects missing/external frames", async () => {
  expect(
    await providerHref(
      '<iframe data-cloud-panel-frame="core" src="/another-provider?x=1&amp;y=2"></iframe>',
      "https://localhost:4100/app/mail",
    ),
  ).toBe("https://localhost:4100/another-provider?x=1&y=2");
  await expect(providerHref("<html></html>", "https://localhost:4100")).rejects.toThrow("Expected one");
  await expect(
    providerHref('<iframe data-cloud-panel-frame="core" src="https://other.invalid/x"></iframe>', "https://localhost:4100"),
  ).rejects.toThrow("same-origin");
  const navs = panelNavigations(
    ["spaces", "mail-mailbox", "notebooks-editor"]
      .map((id) => ({ id, path: `/app/${id}/seed`, status: "ok", errors: [], notes: [], static: null, browsers: [] }))
      .map((page) => {
        // Narrow the fixture IDs through the same result schema used for files.
        return resultSchema.shape.pages.element.parse(page);
      }),
  );
  expect(navs.map((nav) => [nav.id, nav.heading, nav.crossApp])).toEqual([
    ["spaces", "view", false],
    ["mail", "view", false],
    ["notebooks", "start", false],
    ["spaces-to-mail", "view", true],
  ]);
});
