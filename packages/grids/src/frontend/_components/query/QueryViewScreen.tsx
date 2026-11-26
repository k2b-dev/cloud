import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Failed, Loading, Menu, type MenuEntry, Pane, Tabs } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { openViewSettingsDialog } from "../dialogs/ViewSettingsDialogs";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import GridsHero, { type GridsHeroProps } from "../frame/GridsHero";
import { v2Icon } from "../frame/grids-nav";
import { kindMark } from "../frame/kind-marks";
import { recordsScreenMessages } from "../records-view/screen-messages";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationState } from "../workspace/navigation-catalog";
import { queryMessages } from "./messages";
import QueryResults, { type QueryResult, resultFacts, resultLead, summedColumn } from "./QueryResults";

export type QueryViewScreenProps = {
  frame: NavigationState;
  revision?: WorkspaceRevision;
  baseId: string;
  table: Table;
  view: View;
  /** The table's views, for the tabs. */
  views: View[];
  fields: Field[];
  fieldsByTable: Record<string, Field[]>;
  canEditView: boolean;
  initialCursor: string | null;
  initialResult: PublicDslQueryPreviewResponse | null;
};

type PageRequest = { cursor: string | null; history: Array<string | null> };

/**
 * A saved view whose query groups or aggregates on v2: the table's views as tabs, its rows by page of 100. The page
 * stays in the address; its query opens in the query screen, its settings for those who may change it.
 */
export default function QueryViewScreen(props: QueryViewScreenProps) {
  const locale = useLocale();
  const t = () => queryMessages.resolve([locale()]).t;
  const words = () => recordsScreenMessages.resolve([locale()]).t;
  const base = encodeURIComponent(props.baseId);
  const tablePath = `/app/grids/${base}/table/${encodeURIComponent(props.table.id)}`;
  const [result, setResult] = createSignal<PublicDslQueryPreviewResponse | null>(props.initialResult);
  const [pageCursor, setPageCursor] = createSignal<string | null>(props.initialCursor);
  const [pageHistory, setPageHistory] = createSignal<Array<string | null>>([]);

  const page = mutations.create<PublicDslQueryPreviewResponse, PageRequest, PageRequest>({
    onBefore: (request) => request,
    mutation: async (request, { abortSignal }) => {
      const response = await apiClient.gql["by-base"][":baseId"].views[":viewId"].execute.$post(
        {
          param: { baseId: props.baseId, viewId: props.view.id },
          json: { pageSize: 100, ...(request.cursor ? { cursor: request.cursor } : {}), surface: "records-view" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().loadViewPageFailed));
      return response.json();
    },
    onSuccess: (next, request) => {
      setResult(next);
      if (!request) return;
      setPageCursor(request.cursor);
      setPageHistory(request.history);
      const url = new URL(window.location.href);
      if (request.cursor) url.searchParams.set("cursor", request.cursor);
      else url.searchParams.delete("cursor");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    },
  });

  const success = createMemo(() => {
    const current = result();
    return current?.ok ? current : null;
  });
  const failure = () => {
    const current = result();
    if (page.error()) return page.error()?.message ?? t().loadViewPageFailed;
    if (current && !current.ok) return current.diagnostics.map((item) => item.message).join("; ") || t().noViewResult;
    return null;
  };

  /**
   * The hero of a report: what it adds up on this page ("169.260" for a sum by month) with the rows themselves as its
   * trend, oldest first as the view sorts them. A view that adds nothing up has no hero.
   */
  const heroOf = (current: QueryResult): GridsHeroProps | null => {
    const column = summedColumn(current);
    if (!column || current.rows.length === 0) return null;
    const values = current.rows.map((row) => Number(row.values[column.key]) || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      label: column.label,
      figure: total.toLocaleString(locale(), { maximumFractionDigits: 2 }),
      // the figure's name and the other totals of the page; the rows stand in the toolbar over the table
      meta: [
        column.label,
        ...resultFacts(current, locale())
          .filter((fact) => fact.before !== column.label)
          .map((fact) =>
            [fact.before, typeof fact.value === "number" ? fact.value.toLocaleString(locale()) : fact.value].filter(Boolean).join(" "),
          ),
      ].join(" · "),
      trend:
        values.length > 1
          ? { values: values.slice(-31), label: t().trendLabel({ name: column.label, count: Math.min(values.length, 31) }) }
          : undefined,
    };
  };

  const openSettings = () =>
    openViewSettingsDialog({
      baseId: props.baseId,
      tableId: props.table.id,
      viewId: props.view.id,
      tableName: props.table.name,
      initialView: props.view,
      fields: props.fields,
      onSaved: () => window.location.reload(),
    });

  const tabs = () => [
    { label: words().all, icon: v2Icon(props.table.icon, "table"), href: tablePath, current: false },
    ...props.views.map((view) => ({
      label: view.name,
      icon: v2Icon(view.icon, "table-spark"),
      href: `${tablePath}/view/${encodeURIComponent(view.id)}`,
      current: view.id === props.view.id,
    })),
  ];
  const more = (): MenuEntry[] => [
    { label: words().openQuery, icon: "code", href: `${tablePath}/view/${encodeURIComponent(props.view.id)}/query` },
    ...(props.canEditView ? [{ label: t().viewSettings, icon: "settings", onClick: openSettings }] : []),
  ];

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={[`table:${props.table.id}`, `view:${props.view.id}`]}
      revision={props.revision}
      head={<Bar start={<Tabs label={words().views} items={tabs()} />} end={<Menu items={more()} />} />}
    >
      <Pane label={props.view.name} scrollKey={`grids-query-view-${props.view.id}`}>
        <LiveNotice />
        <Show when={result()} fallback={<Loading rows={8} />}>
          <Show
            when={!failure() && success()}
            fallback={<Failed text={failure() ?? t().loadViewFailed} onRetry={() => page.mutate({ cursor: null, history: [] })} />}
          >
            {(resolved) => (
              <>
                <Show when={heroOf(resolved())}>{(hero) => <GridsHero {...hero()} />}</Show>
                <QueryResults
                  // k2b-ui gap: a bar per row in the app's soft colour (the share of each month) has no part yet
                  summary={heroOf(resolved()) ? resultLead(resolved(), locale()) : undefined}
                  result={resolved()}
                  mark={resolved().mode === "groups" ? kindMark("view", props.view.icon) : kindMark("table", props.table.icon)}
                  baseId={props.baseId}
                  fieldsByTable={props.fieldsByTable}
                  loading={page.loading()}
                  canGoBack={pageHistory().length > 0 || pageCursor() !== null}
                  backToFirst={pageHistory().length === 0}
                  onPrevious={() => {
                    const history = pageHistory();
                    if (history.length === 0 && !pageCursor()) return;
                    page.mutate({
                      cursor: history.length > 0 ? (history.at(-1) ?? null) : null,
                      history: history.slice(0, -1),
                    });
                  }}
                  onNext={(cursor) => page.mutate({ cursor, history: [...pageHistory(), pageCursor()] })}
                />
              </>
            )}
          </Show>
        </Show>
      </Pane>
    </GridsFrame>
  );
}
