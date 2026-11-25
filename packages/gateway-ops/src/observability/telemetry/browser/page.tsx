import { listAppsDetailed } from "@k2b/cloud";
import { getLocale } from "@k2b/cloud/server";
import { coreSettings, logging, type WebVitalName, type WebVitalsOverview } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import type { Context, Env } from "hono";
import { observabilityAdminNav } from "../../_components/admin-nav";
import type { KeyCell } from "../../_components/KeyCells";
import { areaText, readAttention } from "../../_components/ObservabilityArea";
import { browserHref, browserQuery, telemetryHref, telemetryQuery } from "../query";
import BrowserScreen from "./BrowserScreen.island";
import { buildVitalCharts, vitalOpsCharts, vitalValue } from "./charts";
import { browserMessages } from "./messages";

const NAMES: WebVitalName[] = ["LCP", "INP", "CLS"];
/** Pages the route list opens; deeper pages are an offset scan nobody reads. */
const PAGE_MAX = 100_000;

/** Browser telemetry (Web Vitals) on v2: `?view=browser` of the telemetry page. */
export async function browserTelemetryPage<E extends Env>(c: Context<E>) {
  const locale = getLocale(c);
  const { t } = browserMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const selectedApp = url.searchParams.get("app") ?? undefined;
  const pageValue = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isInteger(pageValue) && pageValue > 0 && pageValue <= PAGE_MAX ? pageValue : 1;
  const parsed = browserQuery(locale, [], selectedApp).parse(url.searchParams).state;
  const time = parsed.filters.range;
  const filter = {
    range: time.kind === "preset" ? time.preset : ("24h" as const),
    appId: (parsed.filters.app ?? "").slice(0, 64),
    route: (parsed.filters.route ?? "").trim().slice(0, 200),
    page,
  };
  const until = new Date();
  const [dataResult, enabledResult, appsResult, attention] = await Promise.all([
    logging.webVitals(filter, until).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    ),
    coreSettings.get<boolean>("observability.web_vitals.enabled").catch(() => null),
    listAppsDetailed().catch(() => []),
    readAttention(),
  ]);
  const data: WebVitalsOverview | null = dataResult.ok ? dataResult.value : null;
  const apps = appsResult.map((app) => ({ id: app.id, label: app.name }));
  const query = browserQuery(locale, apps, selectedApp);
  const state = { ...parsed, view: "browser" };
  const area = areaText(locale);
  const server = telemetryQuery(locale, apps, selectedApp);
  const serverHref = telemetryHref(server, {
    ...server.reset(),
    filters: { ...server.reset().filters, range: time, app: parsed.filters.app },
  });

  const routes = data
    ? [...new Map(data.routes.map((row) => [`${row.appId}\0${row.route}`, { appId: row.appId, route: row.route }])).values()]
    : [];
  const metric = (appId: string, route: string, name: WebVitalName) => {
    const value = data?.routes.find((row) => row.appId === appId && row.route === route && row.name === name);
    return `${vitalValue(name, value?.p75, locale)} / ${value?.count ?? 0}`;
  };

  return () => (
    <AdminLayout c={c} ui="v2" title={area.telemetry}>
      <BrowserScreen
        nav={observabilityAdminNav(c, locale, attention, "telemetry")}
        apps={apps}
        state={state}
        serverHref={serverHref}
        enabled={enabledResult}
        data={
          data
            ? {
                cells: NAMES.map((name): KeyCell => {
                  const value = data.summary.find((row) => row.name === name);
                  return {
                    icon: name === "LCP" ? "photo" : name === "INP" ? "hand-click" : "layout-distribute-vertical",
                    label: `${name} · p75`,
                    value: vitalValue(name, value?.p75, locale),
                    meta: `${(value?.count ?? 0).toLocaleString(locale)} ${t.samples}`,
                  };
                }),
                charts: vitalOpsCharts(buildVitalCharts(data, locale, filter.range, until.getTime()), locale),
                routes: routes.map((row) => ({
                  key: `${row.appId} ${row.route}`,
                  app: row.appId,
                  route: row.route,
                  lcp: metric(row.appId, row.route, "LCP"),
                  inp: metric(row.appId, row.route, "INP"),
                  cls: metric(row.appId, row.route, "CLS"),
                  href: browserHref(query, { ...state, filters: { ...state.filters, app: row.appId, route: row.route } }),
                })),
                total: data.totalRoutes.toLocaleString(locale),
                previousHref: page > 1 ? browserHref(query, state, page - 1) : null,
                nextHref: page * data.perPage < data.totalRoutes ? browserHref(query, state, page + 1) : null,
              }
            : null
        }
      />
    </AdminLayout>
  );
}
