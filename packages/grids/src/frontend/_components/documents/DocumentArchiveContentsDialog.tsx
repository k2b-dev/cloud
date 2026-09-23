import { fileIcons, text } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, IconButtonLink, PanelDialog, Placeholder, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { documentMessages } from "./messages";
import type { PublicDocument } from "./public-document-types";

const PAGE_SIZE = 50;

/** Pages through the frozen file list of a ZIP Document. */
export default function DocumentArchiveContentsDialog(props: { document: PublicDocument; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const pages = query.createInfinite({
    source: () => props.document.id,
    loadPage: async (documentId, { cursor, abortSignal }: { cursor?: number; abortSignal: AbortSignal }) => {
      const offset = cursor ?? 0;
      const response = await apiClient.documents[":documentId"].contents.$get(
        { param: { documentId }, query: { offset: String(offset), limit: String(PAGE_SIZE) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().archiveContentsLoadFailed);
      const page = await response.json();
      return { ...page, nextCursor: page.hasMore ? offset + page.items.length : undefined };
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const items = () => pages.pages().flatMap((page) => page.items);
  const total = () => pages.pages()[0]?.total ?? 0;
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().archiveContents}
        subtitle={`${props.document.number} · ${t().archiveFileCount({ count: total(), formatted: new Intl.NumberFormat(locale()).format(total()) })}`}
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-dimmed">{t().archiveContentsHint}</p>
          <Show when={pages.loading()}>
            <Placeholder state="loading" align="left" title={t().archiveContents} />
          </Show>
          <Show when={pages.error()}>
            {(error) => (
              <div class="flex flex-col items-start gap-3">
                <Placeholder state="error" align="left" title={error().message} />
                <Button variant="input" onClick={() => pages.refresh()}>
                  {t().retry}
                </Button>
              </div>
            )}
          </Show>
          <Show when={!pages.loading() && !pages.error() && items().length === 0}>
            <Placeholder align="left" title={t().archiveContentsEmpty} />
          </Show>
          <ul class="flex flex-col gap-3">
            <For each={items()}>
              {(item) => (
                <li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                  <i class={`ti ${fileIcons.getFileIcon({ name: item.path, type: "file" })} text-dimmed`} aria-hidden="true" />
                  <div class="min-w-0">
                    <p class="break-words">{item.path}</p>
                    <p class="text-xs text-dimmed">
                      <span class="font-mono">{item.documentId}</span> · {text.pprintBytes(item.sizeBytes, { locale: locale() })}
                    </p>
                  </div>
                  <IconButtonLink
                    variant="ghost"
                    size="sm"
                    navigation="document"
                    href={item.downloadUrl}
                    label={t().downloadNamed({ name: item.path })}
                  >
                    <i class="ti ti-download" aria-hidden="true" />
                  </IconButtonLink>
                </li>
              )}
            </For>
          </ul>
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
