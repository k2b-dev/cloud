import { query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  canPreviewFile,
  DataTable,
  type DataTableColumn,
  dialogCore,
  type FileViewContent,
  FilterChip,
  fileKindLabel,
  formatFileViewSize,
  getFileViewPreviewKind,
  IconButtonLink,
  Lightbox,
  type LightboxItem,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  StatusBadge,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { RetentionFile, RetentionFileStatus, RetentionFilesResponse } from "../../../retention-policy-contracts";
import { errorMessage } from "../utils/api-helpers";
import { useGridsSettingsMessages } from "./messages";

const PAGE_SIZE = 25;

const contentHref = (baseId: string, file: RetentionFile, inline = false): string => {
  const path = `/api/grids/bases/${encodeURIComponent(baseId)}/retention-policy/files/${encodeURIComponent(file.fileId)}/content`;
  return inline ? `${path}?inline=true` : path;
};

/**
 * A retained file in the Lightbox with its type, size and Download. Pictures, PDFs, video and audio read from the
 * inline address; text loads; the Lightbox shows loading, a failure with "Try again", or no preview.
 */
const retentionFileItem = (baseId: string, file: RetentionFile, locale: string, failed: string): LightboxItem => {
  const facts = { path: file.filename, mediaType: file.mimeType, size: file.sizeBytes };
  const kind = getFileViewPreviewKind(facts);
  const read = kind === "image" || kind === "pdf" || kind === "audio" || kind === "video";
  const previewHref = contentHref(baseId, file, true);
  return {
    name: file.filename,
    meta: `${fileKindLabel({ name: file.filename, mediaType: file.mimeType }, locale)} · ${formatFileViewSize(file.sizeBytes, locale)}`,
    file: facts,
    src: read ? previewHref : undefined,
    load:
      kind && !read
        ? // No return type here: Babel's TypeScript parser cannot read one on an arrow inside a conditional.
          async (signal: AbortSignal) => {
            const response = await fetch(previewHref, { signal });
            if (!response.ok) throw new Error(await errorMessage(response, failed));
            const content: FileViewContent = {
              encoding: "utf8",
              content: await response.text(),
              mediaType: response.headers.get("content-type")?.split(";", 1)[0] || file.mimeType,
            };
            return content;
          }
        : undefined,
    thumbnail: kind === "image" ? previewHref : undefined,
    downloadUrl: contentHref(baseId, file),
  };
};

function RetentionFilesDialog(props: { baseId: string; minimumDays: number; close: () => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const bytes = (value: number) => {
    const format = (amount: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(amount);
    if (value < 1024) return `${format(value)} B`;
    if (value < 1024 * 1024) return `${format(value / 1024)} KB`;
    return `${format(value / (1024 * 1024))} MB`;
  };
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const columns = (): DataTableColumn<RetentionFile>[] => [
    { id: "file", header: messages().file, value: (row) => row.filename },
    { id: "size", header: messages().size, value: (row) => row.sizeBytes, align: "right" },
    { id: "status", header: messages().floor, value: (row) => row.status },
    { id: "notBefore", header: messages().floorReached, value: (row) => row.notBefore },
    { id: "actions", header: "", align: "right" },
  ];
  const [searchInput, setSearchInput] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [status, setStatus] = createSignal<RetentionFileStatus>("all");
  const [page, setPage] = createSignal(1);
  const searchDebounce = timed.debounce((value: string) => {
    setPage(1);
    setSearch(value.trim());
  }, 250);

  const requestUrl = () => {
    const params = new URLSearchParams({
      minimumDays: String(props.minimumDays),
      status: status(),
      page: String(page()),
      per_page: String(PAGE_SIZE),
    });
    if (search()) params.set("search", search());
    return `/api/grids/bases/${encodeURIComponent(props.baseId)}/retention-policy/files?${params}`;
  };

  const files = query.create({
    source: requestUrl,
    load: async (url, { abortSignal }): Promise<RetentionFilesResponse> => {
      const response = await fetch(url, { signal: abortSignal });
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadRetainedFilesFailed));
      return response.json();
    },
  });
  const result = () => files.data();
  // This page's files in the Lightbox, above the list, so the arrow keys step through them; one without a preview
  // shows its facts and Download there.
  const previewable = (file: RetentionFile) => canPreviewFile({ path: file.filename, mediaType: file.mimeType, size: file.sizeBytes });
  const [shown, setShown] = createSignal<number | null>(null);
  const lightboxItems = createMemo(() =>
    (result()?.items ?? []).map((file) => retentionFileItem(props.baseId, file, locale(), messages().loadFilePreviewFailed)),
  );
  const openPreview = (file: RetentionFile) => setShown(Math.max(0, (result()?.items ?? []).indexOf(file)));
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.pagination.total === 0) return messages().noFiles;
    const start = (value.pagination.page - 1) * value.pagination.per_page + 1;
    const end = start + value.items.length - 1;
    return messages().filesRange({ start: number(start), end: number(end), total: number(value.pagination.total) });
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().unreferencedFiles}
        subtitle={messages().retentionPreviewDays({ days: number(props.minimumDays) })}
        icon="ti ti-file-search"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DataTable.Header title={rangeLabel()} size="sm">
            <Button size="sm" variant="secondary" disabled={files.loading() || files.refreshing()} onClick={() => void files.refresh()}>
              <i class={files.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> {messages().refresh}
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label={messages().searchRetainedFiles}
                placeholder={messages().searchFilenameOrFileId}
                icon="ti ti-search"
                activeIcon="ti ti-search"
                clearable
                value={searchInput}
                onClear={() => {
                  setSearchInput("");
                  searchDebounce.trigger("");
                }}
                onValueChange={(value) => {
                  setSearchInput(value);
                  searchDebounce.debouncedFn(value);
                }}
              />
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <FilterChip
                label={messages().floorStatus}
                icon="ti ti-filter"
                options={[
                  {
                    options: [
                      { value: "all", label: messages().allFiles },
                      { value: "retained", label: messages().retainedUntilLater },
                      { value: "reached", label: messages().floorReached },
                    ],
                  },
                ]}
                value={[status()]}
                defaultValue={["all"]}
                isActive={status() !== "all"}
                onValueChange={(value) => {
                  setPage(1);
                  setStatus((value[0] ?? "all") as RetentionFileStatus);
                }}
              />
            </div>
          </DataTable.Controls>
          <Show
            when={!files.error()}
            fallback={
              <Placeholder
                state="error"
                title={messages().retainedFilesUnavailable}
                description={files.error() instanceof Error ? files.error()!.message : messages().loadRetainedFilesFailed}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void files.refresh()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns()}
              getRowId={(row) => row.fileId}
              ariaLabel={messages().retainedFilesAria}
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                files.loading() ? (
                  <span>{messages().loadingRetainedFiles}</span>
                ) : search() || status() !== "all" ? (
                  <span>{messages().noFilesMatch}</span>
                ) : (
                  <span>{messages().noUnreferencedFiles}</span>
                )
              }
              renderCell={({ row, col, render, value }) => {
                if (col.id === "file") {
                  return (
                    <div class="min-w-0">
                      <div class="truncate font-medium text-primary">{row.filename}</div>
                      <div class="truncate text-xs text-dimmed">
                        {row.fileId} · {row.mimeType}
                      </div>
                    </div>
                  );
                }
                if (col.id === "size") return bytes(row.sizeBytes);
                if (col.id === "status") {
                  return <StatusBadge tone="neutral" label={row.status === "retained" ? messages().retained : messages().floorReached} />;
                }
                if (col.id === "notBefore") return dateTime(row.notBefore);
                if (col.id === "actions") {
                  return (
                    <div class="flex justify-end gap-1">
                      <Show when={previewable(row)}>
                        <Tooltip.Anchor content={messages().viewFile}>
                          <Button size="sm" variant="ghost" onClick={() => openPreview(row)}>
                            <i class="ti ti-eye" aria-hidden="true" /> {messages().view}
                          </Button>
                        </Tooltip.Anchor>
                      </Show>
                      <Tooltip.Anchor content={messages().downloadFile}>
                        <IconButtonLink
                          size="sm"
                          variant="ghost"
                          href={contentHref(props.baseId, row)}
                          download={row.filename}
                          label={messages().downloadNamedFile({ name: row.filename })}
                        >
                          <i class="ti ti-download" aria-hidden="true" />
                        </IconButtonLink>
                      </Tooltip.Anchor>
                    </div>
                  );
                }
                return render(value);
              }}
            />
          </Show>
          <Show when={(result()?.pagination.total_pages ?? 0) > 1}>
            <DataTable.Footer class="flex items-center justify-between gap-3">
              <span class="text-xs text-dimmed">
                {messages().pageOf({ page: number(page()), total: number(result()?.pagination.total_pages ?? 1) })}
              </span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={files.loading() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  {messages().previous}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={files.loading() || !result()?.pagination.has_next}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {messages().next}
                </Button>
              </div>
            </DataTable.Footer>
          </Show>
        </DataTable.Panel>
      </PanelDialog.Body>
      <Show when={shown() !== null && lightboxItems().length > 0}>
        <Lightbox items={lightboxItems()} index={shown() ?? 0} onIndexChange={setShown} onClose={() => setShown(null)} />
      </Show>
    </PanelDialog>
  );
}

export const openRetentionFilesDialog = (baseId: string, minimumDays: number) =>
  dialogCore.open<void>(
    (close) => <RetentionFilesDialog baseId={baseId} minimumDays={minimumDays} close={() => close()} />,
    panelDialogWorkspaceOptions,
  );
