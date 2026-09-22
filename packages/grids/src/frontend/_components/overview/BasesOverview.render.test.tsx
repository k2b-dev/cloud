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

const app = (index: number) => ({
  id: `App00${index}`,
  name: `Loan desk ${index}`,
  icon: index === 1 ? "scan" : null,
  baseName: "Inventory",
});

type RenderOptions = {
  withBases?: boolean;
  locale?: string;
  apps?: { count: number; total: number; page?: number };
};

const renderOverview = (options: RenderOptions = {}) => {
  const locale = options.locale ?? "en";
  const withBases = options.withBases ?? true;
  const apps = options.apps ?? { count: 0, total: 0 };
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
          apps: {
            items: Array.from({ length: apps.count }, (_, index) => app(index + 1)),
            total: apps.total,
            page: apps.page ?? null,
            pageSize: apps.page ? 48 : 8,
          },
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
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Overview<\/h2>/);
    expect(html).toContain("Recently changed");
    // Without usable apps there is no apps section.
    expect(html).not.toContain("grids-overview-apps");
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
    expect(html).toContain("Übersicht");
    expect(html).toContain("Alle Bases");
    expect(html).toContain("3 Tabellen");
    expect(html).not.toContain("New base");
  });

  test("shows usable apps as tiles above recent tables with a bounded link to all apps", () => {
    const html = renderOverview({ apps: { count: 8, total: 11 } });
    expect(html.match(/class="k2b-paper k2b-link-card/g)).toHaveLength(8);
    expect(html).toContain('href="/apps/App001"');
    expect(html).toContain("ti ti-scan");
    expect(html).toContain("ti ti-app-window");
    expect(html).toContain("Inventory");
    expect(html.indexOf("grids-overview-apps")).toBeLessThan(html.indexOf("Recently changed"));
    expect(html).toContain('href="/app/grids?apps=1"');
    expect(html).toContain("All apps (11)");
  });

  test("omits the all-apps link when every usable app fits", () => {
    const html = renderOverview({ apps: { count: 2, total: 2 } });
    expect(html.match(/class="k2b-paper k2b-link-card/g)).toHaveLength(2);
    expect(html).not.toContain("All apps (");
  });

  test("shows only the apps section to a user without base access", () => {
    const html = renderOverview({ withBases: false, apps: { count: 1, total: 1 } });
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Overview<\/h2>/);
    expect(html).toContain("Apps you can use");
    expect(html).not.toContain('aria-label="Search bases"');
    expect(html).toContain('href="/apps/App001"');
    expect(html).not.toContain("Get started");
    expect(html).not.toContain('aria-label="Create Inventory base"');
    expect(html).not.toContain("Recently changed");
  });

  test("lists every usable app on its own paginated page", () => {
    const html = renderOverview({ apps: { count: 3, total: 51, page: 2 } });
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">All apps<\/h2>/);
    expect(html).toContain("51 apps you can use");
    expect(html).toContain('href="/app/grids"');
    expect(html).toContain('href="/app/grids?apps=1"');
    expect(html).not.toContain("Recently changed");
    expect(html.match(/class="k2b-paper k2b-link-card/g)).toHaveLength(3);
  });
});
