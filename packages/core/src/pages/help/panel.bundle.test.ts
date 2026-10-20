import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { panelIslandEntries } from "../../../../../scripts/fixtures/help-panel";
import { islandBundleSize } from "../../../../../scripts/fixtures/island-bundle-size";
import { islandIdFromFile } from "../../../../ssr/src/island-id";
import { defaultRailPreferences, help, panelUrl, rail, server, settings, snapshot } from "./panel.test-fixture";

// Measured 46,421 B on top of 7fa53cd5b (#1624), plus a 5 % margin, rounded up to the next KiB: 48 KiB. The old island
// measured 121,825 B with this helper. Context: the documented phone profile (200,000 B/s, WebKit sheet limit 1,000 ms)
// puts a quarter of that limit at 50,000 B. The helper builds these islands alone; Core's served build measured 70,007 B,
// because its shared chunks also carry code of other Core islands.
export const PANEL_HELP_EAGER_BROTLI_BUDGET = 48 * 1024;

test("every island in the actual /panel HTML is inside the eager bundle budget", async () => {
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
    spyOn(help, "createHelpReader").mockImplementation((locale) => ({
      manifest: async () => ({
        manifestHash: "fixture",
        pageBase: "/help/apps/spaces",
        baseLocale: "en",
        locale,
        documents: [{ id: "share", title: "Share", order: 1, url: "/api/help/share", searchUrl: "/api/help/search", locale }],
      }),
      list: async () => [],
      search: async () => [],
      read: async ({ appId, documentId }) => ({
        appId,
        documentId,
        appName: "Spaces",
        title: "Share",
        locale,
        manifestHash: "fixture",
        order: 1,
        kind: "task",
        related: [],
        links: {},
        markdown: "Share.\n\n## Invite\n\nInvite a person.",
      }),
    })),
  ];
  try {
    // panel.test-fixture uses a temporary SSR root; entries outside it use canonical absolute island ids.
    const expected = panelIslandEntries.map((entry) => islandIdFromFile(entry, resolve("/tmp/panel-budget-root"))).sort();
    for (const suffix of ["", "&topic=share"]) {
      const response = await server.request(panelUrl("spaces", ["share"]) + suffix);
      expect(response.status).toBe(200);
      const html = await response.text();
      const ids = [...html.matchAll(/<solid-island\b[^>]*data-id="([^"]+)"/g)].map((match) => match[1]).sort();
      expect(ids).toEqual(expected);
    }
    const size = await islandBundleSize(panelIslandEntries);
    expect(size.eagerBrotliBytes).toBeLessThanOrEqual(PANEL_HELP_EAGER_BROTLI_BUDGET);
    for (const heavy of [
      /\/marked\//,
      /\/MarkdownView\./,
      /\/TableOfContents\./,
      /\/Dropdown\./,
      /\/toast\./,
      /\/layout-help-markdown\./,
      /\/layout-help-search\./,
      /\/solid\/clipboard\./,
    ]) {
      expect(size.dynamicInputs.some((input) => heavy.test(input))).toBe(true);
      expect(size.eagerInputs.filter((input) => heavy.test(input))).toEqual([]);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}, 60_000);
