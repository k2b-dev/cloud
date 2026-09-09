import type { DateContext } from "@k2b/stdlib";
import { Button, IconButton, Placeholder, ScrollArea, Tag, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { documentActionState } from "./document-browser-model";
import { formatDocumentRelativeTime } from "./document-workspace-utils";
import { documentMessages } from "./messages";
import type { PublicDocument, PublicDocumentFolder } from "./public-document-types";

export type DocumentBreadcrumb = { label: string; path: string[] };

type Props = {
  loading: boolean;
  error: Error | undefined;
  mode: "list" | "folders";
  searching: boolean;
  folders: PublicDocumentFolder[];
  documents: PublicDocument[];
  breadcrumbs: DocumentBreadcrumb[];
  emptyText: string;
  hasMore: boolean;
  loadingMore: boolean;
  busyDocumentId: string | null;
  canWrite: boolean;
  dateConfig?: DateContext;
  folderTitle: (folder: PublicDocumentFolder) => string;
  onBreadcrumb: (path: string[]) => void;
  onFolder: (folder: PublicDocumentFolder) => void;
  onDocument: (document: PublicDocument) => void;
  onEdit: (document: PublicDocument) => void;
  onLink: (document: PublicDocument) => void;
  onDownload: (document: PublicDocument) => void;
  onLoadMore: () => void;
};

function DocumentTags(props: { tags: string[] }) {
  return (
    <Show when={props.tags.length > 0} fallback={<span class="text-dimmed">-</span>}>
      <span class="flex min-w-0 flex-wrap items-center gap-1">
        <For each={props.tags}>
          {(tag) => (
            <Tag size="sm" class="max-w-32 truncate">
              {tag}
            </Tag>
          )}
        </For>
      </span>
    </Show>
  );
}

export default function DocumentBrowser(props: Props) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const dateConfig = () => ({ ...props.dateConfig, locale: locale() });
  const renderDocumentActions = (document: PublicDocument) => {
    const state = () => documentActionState(props.canWrite, props.busyDocumentId, document.id);
    return (
      <div class="flex shrink-0 items-center gap-1">
        <Show when={state().showEdit}>
          <IconButton
            variant="ghost"
            size="sm"
            class="shrink-0 text-dimmed hover:text-secondary"
            label={t().documentDetails}
            onClick={(event) => {
              event.stopPropagation();
              props.onEdit(document);
            }}
          >
            <i class="ti ti-info-circle" />
          </IconButton>
          <IconButton
            variant="ghost"
            size="sm"
            class="shrink-0 text-dimmed hover:text-secondary"
            label={t().createPublicLink}
            onClick={(event) => {
              event.stopPropagation();
              props.onLink(document);
            }}
          >
            <i class="ti ti-link" />
          </IconButton>
        </Show>
        <IconButton
          variant="ghost"
          size="sm"
          class="shrink-0 text-dimmed hover:text-secondary"
          label={t().downloadDocument}
          onClick={(event) => {
            event.stopPropagation();
            props.onDownload(document);
          }}
          disabled={state().downloadBusy}
        >
          {state().downloadBusy ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-download" />}
        </IconButton>
      </div>
    );
  };

  return (
    <section class="min-h-0 flex-1 overflow-hidden">
      <Show
        when={!props.loading}
        fallback={<Placeholder state="loading" class="h-full" title={t().loadingDocuments} description={t().readingGeneratedDocuments} />}
      >
        <Show
          when={!props.error}
          fallback={
            <Placeholder
              state="error"
              class="h-full"
              title={t().couldNotLoadGeneratedDocuments}
              description={props.error?.message?.trim() !== t().couldNotLoadGeneratedDocuments ? props.error?.message : undefined}
            />
          }
        >
          <div class="flex h-full min-h-0 flex-col overflow-hidden">
            <Show when={props.mode === "folders" && !props.searching}>
              <div class="flex shrink-0 items-center gap-1 px-3 py-2 text-xs text-secondary">
                <For each={props.breadcrumbs}>
                  {(crumb, index) => (
                    <>
                      <Show when={index() > 0}>
                        <i class="ti ti-chevron-right text-dimmed" />
                      </Show>
                      <button
                        type="button"
                        class={`rounded px-1 py-0.5 hover:text-primary ${
                          index() === props.breadcrumbs.length - 1 ? "font-medium text-primary" : ""
                        }`}
                        onClick={() => props.onBreadcrumb(crumb.path)}
                      >
                        {crumb.label}
                      </button>
                    </>
                  )}
                </For>
              </div>
            </Show>
            <ScrollArea class="min-h-0 flex-1 p-1">
              <Show
                when={props.folders.length > 0 || props.documents.length > 0}
                fallback={<Placeholder class="h-full" title={props.emptyText} />}
              >
                <Show when={props.mode === "folders" && !props.searching && props.folders.length > 0}>
                  <For each={props.folders}>
                    {(folder) => (
                      <button
                        type="button"
                        class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--ui-paper-highlighted)]"
                        onClick={() => props.onFolder(folder)}
                      >
                        <div class="flex min-w-0 items-center gap-2">
                          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                            <i class="ti ti-folder" />
                          </span>
                          <span class="min-w-0">
                            <span class="block truncate font-medium text-primary">{props.folderTitle(folder)}</span>
                            <span class="block text-xs text-dimmed">
                              {t().documentCount({ count: folder.count, formatted: new Intl.NumberFormat(locale()).format(folder.count) })}
                            </span>
                          </span>
                        </div>
                        <i class="ti ti-chevron-right text-dimmed" />
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={props.mode !== "folders" || props.documents.length > 0 || props.searching}>
                  <For each={props.documents}>
                    {(document) => (
                      <div class="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2 text-sm transition-colors hover:bg-[var(--ui-paper-highlighted)]">
                        <button type="button" class="min-w-0 text-left" onClick={() => props.onDocument(document)}>
                          <div class="flex min-w-0 items-center gap-2">
                            <i class="ti ti-file-type-pdf shrink-0 text-dimmed" />
                            <span class="truncate font-medium text-primary">{document.filename}</span>
                          </div>
                          <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-dimmed">
                            <span class="font-mono">{document.number}</span>
                            <DocumentTags tags={document.tags} />
                          </div>
                        </button>
                        <span class="hidden text-xs text-dimmed sm:block">
                          {formatDocumentRelativeTime(document.createdAt, dateConfig())}
                        </span>
                        {renderDocumentActions(document)}
                      </div>
                    )}
                  </For>
                  <Show when={props.hasMore}>
                    <div class="flex justify-center p-3">
                      <Button variant="secondary" size="sm" type="button" onClick={props.onLoadMore} disabled={props.loadingMore}>
                        {props.loadingMore ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-dots" />}
                        {t().loadMoreDocuments}
                      </Button>
                    </div>
                  </Show>
                </Show>
              </Show>
            </ScrollArea>
          </div>
        </Show>
      </Show>
    </section>
  );
}
