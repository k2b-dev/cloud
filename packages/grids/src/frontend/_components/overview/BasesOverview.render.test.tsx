import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: BasesOverview } = await import("./BasesOverview.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");

const base = {
  id: "Base01",
  name: "CRM",
  description: "Customers and deals",
  documentDefaults: {},
  createdBy: null,
  deletedAt: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};
const template = {
  id: "inventory",
  name: "Inventory",
  description: "Equipment",
  icon: "ti ti-package",
  highlights: ["Tables", "Forms", "Apps"] as [string, string, string],
};

const renderOverview = (options: { withBases?: boolean; locale?: string } = {}) => {
  const locale = options.locale ?? "en";
  const withBases = options.withBases ?? true;
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BasesOverview, {
          bases: withBases ? [base] : [],
          total: withBases ? 1 : 0,
          limit: 100,
          offset: 0,
          initialQuery: "",
          templates: [template],
          baseStats: withBases ? { Base01: { tableCount: 3, lastActivityAt: "2026-08-20T10:00:00.000Z" } } : {},
          recentTables: withBases
            ? [
                {
                  id: "Tabl01",
                  baseId: "Base01",
                  baseName: "CRM",
                  name: "Deals",
                  icon: null,
                  lastActivityAt: "2026-08-20T10:00:00.000Z",
                },
              ]
            : [],
          dateConfig: { locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        });
      },
    }),
  );
};

describe("Grids bases overview", () => {
  test("lists bases as sidebar objects and recent tables across all bases", () => {
    const html = renderOverview();
    expect(html).toContain('class="k2b-app-workspace grids-overview-workspace"');
    expect(html).toMatch(/<aside[^>]*aria-label="Bases"[^>]*data-mobile="stacked"/);
    expect(html).not.toContain("k2b-app-workspace__nav-tree");
    expect(html).toContain("--k2b-workspace-sidebar-width:304px");
    expect(html.match(/data-variant="object"/g)).toHaveLength(1);
    expect(html).toContain('href="/app/grids/Base01"');
    expect(html).toContain("3 tables");
    // Every base shares the default icon, so object rows carry none.
    expect(html).not.toContain("k2b-app-workspace__sidebar-item-icon");
    expect(html).toContain('aria-label="Search bases"');
    expect(html).toMatch(/class="k2b-app-workspace__main[^"]*grids-overview-main ?"[^>]*data-width="content"/);
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Recently changed<\/h2>/);
    expect(html).toContain("All bases");
    expect(html).toContain("New base");
    expect(html).toContain('href="/app/grids/Base01/table/Tabl01"');
    expect(html).toContain("Deals");
    expect(html).toContain('datetime="2026-08-20T10:00:00.000Z"');
    // Templates move into the create menu once bases exist.
    expect(html).not.toContain('aria-label="Create Inventory base"');
  });

  test("shows the templates as the first screen before any base exists", () => {
    const html = renderOverview({ withBases: false });
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Get started<\/h2>/);
    expect(html).toContain('aria-label="Create Inventory base"');
    expect(html).toContain("Blank base");
    expect(html).not.toContain("All bases");
    expect(html).not.toContain('aria-label="Search bases"');
  });

  test("renders German copy for a regional request locale during SSR", () => {
    const html = renderOverview({ locale: "de-CH" });
    expect(html).toContain("Neue Base");
    expect(html).toContain("Zuletzt geändert");
    expect(html).toContain("Alle Bases");
    expect(html).toContain("3 Tabellen");
    expect(html).not.toContain("New base");
  });
});
