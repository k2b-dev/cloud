import { listAppsDetailed } from "@k2b/cloud";
import { getLocale } from "@k2b/cloud/server";
import { coreSettings, logging, type WebVitalName, type WebVitalsOverview } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink, DataTable, NoticeCard, StatCell, StatGrid } from "@k2b/ui";
import type { Context, Env } from "hono";
import Controls from "./Controls.island";
import { buildVitalCharts, vitalValue } from "./charts";
import { browserUrl, parseBrowserFilter } from "./filter";
import ModeNav from "./ModeNav";
import { browserMessages } from "./messages";
import VitalCharts from "./VitalCharts.island";

export async function browserTelemetryPage<E extends Env>(c: Context<E>) {
  const locale = getLocale(c);
  const { t } = browserMessages.resolve([locale]);
  const filter = parseBrowserFilter(new URL(c.req.url));
  const until = new Date();
  const [dataResult, enabledResult, appsResult] = await Promise.allSettled([
    logging.webVitals(filter, until),
    coreSettings.get<boolean>("observability.web_vitals.enabled"),
    listAppsDetailed(),
  ]);
  const data: WebVitalsOverview | null = dataResult.status === "fulfilled" ? dataResult.value : null;
  const enabled = enabledResult.status === "fulfilled" ? enabledResult.value : null;
  const apps = appsResult.status === "fulfilled" ? appsResult.value.map((app) => ({ id: app.id, name: app.name })) : [];
  const charts = data ? buildVitalCharts(data, locale, filter.range, until.getTime()) : [];
  const names: WebVitalName[] = ["LCP", "INP", "CLS"];
  const routes = data
    ? [...new Map(data.routes.map((row) => [`${row.appId}\0${row.route}`, { appId: row.appId, route: row.route }])).values()]
    : [];
  const metric = (appId: string, route: string, name: WebVitalName) =>
    data?.routes.find((row) => row.appId === appId && row.route === route && row.name === name);
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <div>
          <h1 class="text-base font-semibold text-primary">{t.title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.description}</p>
        </div>
        <ModeNav url={c.req.url} locale={locale} browser />
        <Controls filter={filter} apps={apps} enabled={enabled} />
        <NoticeCard tone="info" title={t.metricsTitle}>
          <dl class="grid grid-cols-1 xl:grid-cols-3 gap-3">
            {names.map((name) => (
              <div>
                <dt class="font-semibold">{name}</dt>
                <dd>{name === "LCP" ? t.lcpHelp : name === "INP" ? t.inpHelp : t.clsHelp}</dd>
              </div>
            ))}
          </dl>
          <p class="mt-2">{t.guidance}</p>
          <a class="underline" href="https://web.dev/articles/vitals" target="_blank" rel="noreferrer">
            {t.learnMore}
          </a>
        </NoticeCard>
        {data ? (
          <>
            <StatGrid columns={3}>
              {names.map((name) => {
                const value = data.summary.find((row) => row.name === name);
                return (
                  <StatCell
                    label={`${name} · p75`}
                    value={vitalValue(name, value?.p75, locale)}
                    sub={`${(value?.count ?? 0).toLocaleString(locale)} ${t.samples}`}
                  />
                );
              })}
            </StatGrid>
            <p class="text-xs text-dimmed">{t.note}</p>
            {data.summary.length === 0 ? <p class="paper p-3 text-xs text-dimmed">{t.empty}</p> : <VitalCharts charts={charts} />}
            <DataTable.Panel>
              <DataTable.Header title={t.routes} subtitle={`${data.totalRoutes.toLocaleString(locale)} ${t.count}`} size="sm" />
              <DataTable
                surface="paper"
                rows={routes}
                renderCell={({ row, col, value }) =>
                  col.id === "route" ? (
                    <a class="hover:underline" href={browserUrl(filter, { appId: row.appId, route: row.route, page: 1 })}>
                      {row.route}
                    </a>
                  ) : (
                    String(value ?? "—")
                  )
                }
                columns={[
                  { id: "app", header: t.app, value: (row) => row.appId },
                  { id: "route", header: t.route, value: (row) => row.route },
                  ...names.map((name) => ({
                    id: name,
                    header: `${name} · p75 / n`,
                    value: (row: { appId: string; route: string }) => {
                      const value = metric(row.appId, row.route, name);
                      return `${vitalValue(name, value?.p75, locale)} / ${value?.count ?? 0}`;
                    },
                  })),
                ]}
              />
              {(filter.page > 1 || filter.page * data.perPage < data.totalRoutes) && (
                <DataTable.Footer>
                  <div class="flex gap-2">
                    {filter.page > 1 && (
                      <ButtonLink size="sm" variant="secondary" href={browserUrl(filter, { page: filter.page - 1 })}>
                        {t.previous}
                      </ButtonLink>
                    )}
                    {filter.page * data.perPage < data.totalRoutes && (
                      <ButtonLink size="sm" variant="secondary" href={browserUrl(filter, { page: filter.page + 1 })}>
                        {t.next}
                      </ButtonLink>
                    )}
                  </div>
                </DataTable.Footer>
              )}
            </DataTable.Panel>
          </>
        ) : (
          <section class="paper p-3">
            <p role="alert" class="text-xs text-red-600">
              {t.error}
            </p>
            <ButtonLink size="sm" variant="secondary" href={browserUrl(filter)}>
              {t.retry}
            </ButtonLink>
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
