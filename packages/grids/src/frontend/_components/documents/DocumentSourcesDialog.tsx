import { query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, PanelDialog, Placeholder, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { documentMessages } from "./messages";
import type { PublicDocument } from "./public-document-types";

export default function DocumentSourcesDialog(props: { document: PublicDocument; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const pages = query.createInfinite({
    source: () => props.document.id,
    loadPage: async (documentId, { cursor, abortSignal }: { cursor?: number; abortSignal: AbortSignal }) => {
      const offset = cursor ?? 0;
      const response = await apiClient.documents[":documentId"].sources.$get(
        { param: { documentId }, query: { offset: String(offset), limit: "50" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().sourceRecordsLoadFailed);
      const page = await response.json();
      return { ...page, nextCursor: page.hasMore ? offset + page.items.length : undefined };
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const items = () => pages.pages().flatMap((page) => page.items);
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().sourceRecords} subtitle={props.document.number} close={props.close} />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-dimmed">{t().sourceRecordsHint}</p>
          <Show when={pages.loading()}>
            <Placeholder icon="ti ti-loader" title={t().sourceRecords} />
          </Show>
          <Show when={pages.error()}>
            {(error) => (
              <div class="flex flex-col items-start gap-3">
                <Placeholder title={error().message} />
                <Button variant="input" onClick={() => pages.refresh()}>
                  {t().retry}
                </Button>
              </div>
            )}
          </Show>
          <Show when={!pages.loading() && !pages.error() && items().length === 0}>
            <Placeholder title={t().sourceRecordsEmpty} />
          </Show>
          <For each={items()}>
            {(item) => (
              <div class="flex items-center justify-between gap-3 text-sm">
                <div class="min-w-0">
                  <Show
                    when={!item.deleted}
                    fallback={
                      <p>
                        {item.label} · {t().sourceRecordDeleted}
                      </p>
                    }
                  >
                    <ButtonLink
                      variant="text"
                      navigation="document"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={`/app/grids/${props.document.baseId}/table/${item.tableId}?record=${item.recordId}`}
                    >
                      {item.label}
                      <i class="ti ti-arrow-up-right" aria-hidden="true" />
                    </ButtonLink>
                  </Show>
                  <p class="text-xs text-dimmed">
                    {item.tableName}
                    {item.version == null ? "" : ` · ${t().sourceRecordVersion({ version: item.version })}`}
                  </p>
                </div>
              </div>
            )}
          </For>
          <Show when={pages.hasMore()}>
            <Button variant="input" loading={pages.loadingMore()} onClick={() => pages.loadMore()}>
              {t().sourceRecordsMore}
            </Button>
          </Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}
