import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: BasesOverview } = await import("./BasesOverview.island.tsx");
const { basesQuery } = await import("./bases-query");
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
  search?: string;
  create?: string;
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
          state: basesQuery(locale).parse(options.search ? `q=${options.search}` : "").state,
          page: 1,
          create: options.create ?? null,
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
          },
          dateConfig: { locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        });
      },
    }),
  );
};

describe("Grids bases overview on v2", () => {
  test("lists the bases as a table beside the apps and the recently changed tables", () => {
    const html = renderOverview();
    expect(html).toContain('data-k2-part="Workspace"');
    expect(html).toContain('data-k2-part="Table"');
    expect(html).toContain('href="/app/grids/Base01"');
    expect(html).toContain("Customers and deals");
    expect(html).toContain("1 base");
    expect(html).toContain('aria-label="Search bases"');
    expect(html).toContain("New base");
    expect(html).toContain('href="/app/grids?new=blank"');
    expect(html).toContain("Recently changed");
    expect(html).toContain('href="/app/grids/Base01/table/Tabl01"');
    expect(html).toContain("Deals");
    // Without usable apps there is no apps section and no tabs.
    expect(html).not.toContain('data-k2-part="Tiles"');
    expect(html).not.toContain('data-k2-part="Tabs"');
    // Templates wait in the create dialog once bases exist; nothing loads on the first picture.
    expect(html).not.toContain("Get started");
    expect(html).not.toContain('data-k2-part="Loading"');
    expect(html).not.toMatch(/\bclass="(?!k2-|ti )[^"]*"/);
  });

  test("shows the templates as the first screen before any base exists", () => {
    const html = renderOverview({ withBases: false });
    expect(html).toContain("Get started");
    expect(html).toContain('href="/app/grids?new=inventory"');
    expect(html).toContain("Blank base");
    expect(html).not.toContain('aria-label="Search bases"');
  });

  test("says when a search finds nothing and offers the whole list", () => {
    const html = renderOverview({ withBases: false, search: "zzz" });
    expect(html).toContain("No matching bases");
    expect(html).toContain("Show all bases");
    expect(html).toContain('value="zzz"');
  });

  test("renders German copy for a regional request locale during SSR", () => {
    const html = renderOverview({ locale: "de-CH" });
    expect(html).toContain("Neue Base");
    expect(html).toContain("Zuletzt geändert");
    expect(html).toContain("Tabellen");
    expect(html).not.toContain("New base");
  });

  test("shows usable apps as tiles with a bounded link to all apps", () => {
    const html = renderOverview({ apps: { count: 8, total: 11 } });
    expect(html).toContain('data-k2-part="Tabs"');
    expect(html.match(/class="k2-tile"/g)).toHaveLength(8);
    expect(html).toContain('href="/apps/App001"');
    expect(html).toContain("ti-scan");
    expect(html).toContain("ti-app-window");
    expect(html).toContain('href="/app/grids?apps=1"');
    expect(html).toContain("All apps (11)");
  });

  test("omits the all-apps link when every usable app fits", () => {
    const html = renderOverview({ apps: { count: 2, total: 2 } });
    expect(html.match(/class="k2-tile"/g)).toHaveLength(2);
    expect(html).not.toContain("All apps (");
  });

  test("lists every usable app on its own paginated page", () => {
    const html = renderOverview({ apps: { count: 3, total: 51, page: 2 } });
    expect(html).toContain("51 apps");
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain('href="/app/grids?apps=1"');
    expect(html).not.toContain("Recently changed");
    expect(html.match(/class="k2-tile"/g)).toHaveLength(3);
  });
});
