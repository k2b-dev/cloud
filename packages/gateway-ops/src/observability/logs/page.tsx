import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { requestPath } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { buildLogFilterUrl, LOG_WINDOWS, parseLogFilterFromUrl } from "./_components/types";
import { createPagination } from "./contracts";
import { loggingService } from "./service";
import { LOGS_PAGE_PATH, LogsView } from "./view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const url = new URL(c.req.url);
  const filter = parseLogFilterFromUrl(url);

  const perPage = 100;
  const pagination = { page: filter.page, perPage, offset: (filter.page - 1) * perPage };
  const scopedFilter = {
    sources: filter.sources.length > 0 ? filter.sources : undefined,
    level: filter.level !== "all" ? filter.level : undefined,
    search: filter.search || undefined,
    sinceHours: LOG_WINDOWS[filter.window],
  };

  // A logging backend that is down must degrade the page, not 500 it: the
  // operator still needs the rest of the console to diagnose why.
  const [listResult, sources, summary, sourceStats, timeseriesResult] = await Promise.all([
    loggingService.entry
      .list({
        pagination,
        filter: scopedFilter,
      })
      .then((result) => ({ result, error: null as string | null }))
      .catch((error) => ({ result: { items: [], total: 0 }, error: error instanceof Error ? error.message : String(error) })),
    loggingService.source.list().catch(() => []),
    loggingService.stats.summary().catch(() => null),
    loggingService.stats.by({ groupBy: "source", limit: 1, ...scopedFilter }).catch(() => []),
    loggingService.stats
      .timeseries(scopedFilter)
      .then((points) => ({ points, error: null as string | null }))
      .catch((error) => ({ points: [], error: error instanceof Error ? error.message : String(error) })),
  ]);
  const { items: entries, total } = listResult.result;
  const loadError = listResult.error;
  const topSource = sourceStats[0] ?? null;

  const paginationResult = createPagination(pagination, total);
  const baseUrl = (() => {
    const withoutPage = buildLogFilterUrl(LOGS_PAGE_PATH, { page: 1 }, filter);
    return withoutPage.includes("?") ? `${withoutPage}&page=` : `${withoutPage}?page=`;
  })();

  const retentionState = await read("logs.retention_days");
  const retentionDays = Number(retentionState.value);

  // The entry open in the detail column. Ids are row numbers; anything else opens nothing.
  const entryParam = url.searchParams.get("entry");
  const selectedId = entryParam && /^\d{1,19}$/.test(entryParam) ? entryParam : null;
  const [attention, selected] = await Promise.all([
    readAttention(),
    selectedId
      ? loggingService.entry
          .get({ id: selectedId })
          .then((entry) => ({ entry, error: null as string | null }))
          .catch((error) => ({ entry: null, error: error instanceof Error ? error.message : String(error) }))
      : Promise.resolve(null),
  ]);
  return () => (
    <LogsView
      c={c}
      locale={locale}
      timeZone={getTimeZone(c)}
      attention={attention}
      filter={filter}
      entries={entries}
      total={total}
      totalPages={paginationResult.total_pages}
      baseUrl={baseUrl}
      sources={sources}
      loadError={loadError}
      summary={summary}
      topSource={topSource}
      timeseriesResult={timeseriesResult}
      retentionDays={retentionDays}
      selectedId={selectedId}
      selected={selected}
      retryHref={requestPath(c)}
    />
  );
});
