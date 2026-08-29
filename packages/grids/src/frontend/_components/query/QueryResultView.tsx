import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicTable as Table } from "../../../api/public-dto";
import { openViewSettingsDialog } from "../dialogs/ViewSettingsDialogs";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkspaceQueryResultViewRoute } from "../workspace/workspace-public-state-model";
import { queryMessages } from "./messages";
import QueryResultTable from "./QueryResultTable";

const leaveEditMode = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete("edit");
  window.location.assign(`${url.pathname}${url.search}`);
};

const syncCursorToUrl = (cursor: string | null) => {
  const url = new URL(window.location.href);
  if (cursor) url.searchParams.set("cursor", cursor);
  else url.searchParams.delete("cursor");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
};

export default function QueryResultView(props: {
  baseId: string;
  route: PublicWorkspaceQueryResultViewRoute;
  tables: Table[];
  fieldsByTable: Record<string, Field[]>;
  editMode: boolean;
}) {
  const { t } = queryMessages.resolve([useLocale()()]);
  type PageRequest = { cursor: string | null; history: Array<string | null> };
  const openSettings = () => {
    if (!props.route.canEditActiveView) return;
    openViewSettingsDialog({
      baseId: props.baseId,
      tableId: props.route.activeTable.id,
      viewId: props.route.activeView.id,
      tableName: props.route.activeTable.name,
      initialView: props.route.activeView,
      fields: props.route.fields,
      onSaved: () => window.location.reload(),
    });
  };
  const [result, setResult] = createSignal<PublicDslQueryPreviewResponse | null>(props.route.initialResult);
  const [pageCursor, setPageCursor] = createSignal<string | null>(props.route.initialCursor);
  const [pageHistory, setPageHistory] = createSignal<Array<string | null>>([]);
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => setHydrated(true));
  const pageMut = mutations.create<PublicDslQueryPreviewResponse, PageRequest, PageRequest>({
    onBefore: (request) => request,
    mutation: async (request, { abortSignal }) => {
      const response = await apiClient.gql["by-base"][":baseId"].views[":viewId"].execute.$post(
        {
          param: { baseId: props.baseId, viewId: props.route.activeView.id },
          json: { pageSize: 100, ...(request.cursor ? { cursor: request.cursor } : {}), surface: "records-view" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t.loadViewPageFailed));
      return response.json();
    },
    onSuccess: (next, request) => {
      setResult(next);
      if (!request) return;
      setPageCursor(request.cursor);
      setPageHistory(request.history);
      syncCursorToUrl(request.cursor);
    },
    onError: (error) => prompts.error(error.message),
  });
  const success = createMemo(() => {
    const current = result();
    return current?.ok ? current : null;
  });
  const diagnostics = createMemo(() => {
    const current = result();
    return current && !current.ok ? current.diagnostics : [];
  });

  return (
    <div class="flex h-full min-h-0 flex-1 flex-col gap-2">
      <Show when={props.editMode && props.route.canEditActiveView}>
        <div class="flex shrink-0 items-center gap-2">
          <Button variant="success" size="sm" type="button" onClick={openSettings}>
            <i class="ti ti-table-spark" aria-hidden="true" /> {t.view}
          </Button>
          <Button variant="ghost" size="sm" type="button" class="ml-auto" onClick={leaveEditMode}>
            {t.done}
          </Button>
        </div>
      </Show>
      <Show
        when={result()}
        fallback={<Placeholder state="loading" surface="paper" title={t.loadingView} description={t.preparingResult} />}
      >
        <Show
          when={success()}
          fallback={
            <Placeholder
              state="error"
              surface="paper"
              title={t.loadViewFailed}
              description={
                diagnostics()
                  .map((item) => item.message)
                  .join("; ") || t.noViewResult
              }
              action={
                <div class="flex flex-wrap items-center justify-center gap-2">
                  <Show when={pageCursor()}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={pageMut.loading()}
                      onClick={() => pageMut.mutate({ cursor: null, history: [] })}
                    >
                      <i class="ti ti-chevrons-left" aria-hidden="true" /> {t.firstPage}
                    </Button>
                  </Show>
                  <Show when={props.route.canEditActiveView}>
                    <Button variant="secondary" size="sm" type="button" onClick={openSettings}>
                      <i class="ti ti-settings" aria-hidden="true" /> {t.viewSettings}
                    </Button>
                  </Show>
                </div>
              }
            />
          }
        >
          {(resolved) => (
            <QueryResultTable
              result={resolved()}
              baseId={props.baseId}
              fieldsByTable={props.fieldsByTable}
              scrollPreserveKey={`grids-query-result-view-${props.route.activeView.id}`}
              loading={!hydrated() || pageMut.loading()}
              canGoBack={pageHistory().length > 0 || pageCursor() !== null}
              backLabel={pageHistory().length > 0 ? "Previous" : "First page"}
              onPrevious={() => {
                const history = pageHistory();
                if (history.length === 0 && !pageCursor()) return;
                pageMut.mutate({
                  cursor: history.length > 0 ? (history.at(-1) ?? null) : null,
                  history: history.length > 0 ? history.slice(0, -1) : [],
                });
              }}
              onNext={(cursor) => pageMut.mutate({ cursor, history: [...pageHistory(), pageCursor()] })}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}
