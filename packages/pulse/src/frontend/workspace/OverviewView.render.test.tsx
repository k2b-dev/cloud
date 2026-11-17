import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Overview } from "../../overview-contracts";

const root = mkdtempSync(join(tmpdir(), "pulse-activity-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: OverviewView } = await import("./OverviewView");
const NOW = "2026-11-12T15:31:00.000Z";
const snapshot: Overview = {
  baseId: "Base01",
  name: "Example",
  timezone: "UTC",
  readAt: NOW,
  storeUnavailable: false,
  sources: { total: 1, current: 1 },
  attention: { items: [], total: 0, nextOffset: null },
  numbers: [],
  activity: {
    nextCursor: null,
    items: [
      { id: "1", at: NOW, kind: "source_created", actor: { kind: "user", id: "Person01", name: "Mira Lang" }, data: { name: "Daily readings" } },
      { id: "2", at: NOW, kind: "query_saved", actor: { kind: "service_account", id: "Service1", name: "Import service" }, data: { name: "Daily total" } },
      { id: "3", at: NOW, kind: "source_freshness", actor: null, data: { name: "Daily readings", stale: false } },
    ],
  },
};

test.each(["en", "de"])("%s activity distinguishes people, services and automatic changes without native hints", (locale) => {
  const noop = () => {};
  const html = renderToString(() => createComponent(LocaleProvider, {
    locale,
    get children() {
      return createComponent(OverviewView, {
        data: snapshot, loading: false, error: null, canWrite: false, retry: noop, addSource: noop,
        openSource: noop, openAlert: noop, askAssistant: noop, assistantPending: false, assistantError: null,
        loadAttention: noop, loadActivity: noop, paging: false,
      });
    },
  }));
  const found = { rows: 0, people: 0, services: 0, automatic: 0, titles: 0 };
  new HTMLRewriter()
    .on(".k2b-activity__entry", { element: () => { found.rows++; } })
    .on(".k2b-activity__avatar [data-tint]", { element: () => { found.people++; } })
    .on('.k2b-activity__avatar [data-shape="square"] .ti-robot', { element: () => { found.services++; } })
    .on(".k2b-activity__avatar .ti-settings", { element: () => { found.automatic++; } })
    .on(".k2b-activity [title]", { element: () => { found.titles++; } })
    .transform(html);
  expect(found).toEqual({ rows: 3, people: 1, services: 1, automatic: 1, titles: 0 });
  expect(html).toContain("Mira Lang");
  expect(html).toContain("Import service");
  expect(html).toContain(locale === "de" ? "automatisch" : "automatic");
});
