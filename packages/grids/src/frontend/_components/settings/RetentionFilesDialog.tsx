import { fileIcons } from "@k2b/stdlib";
import { query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  canPreviewFile,
  DataTable,
  type DataTableColumn,
  dialogCore,
  FileView,
  type FileViewContent,
  FilterChip,
  formatFileViewSize,
  getFileViewPreviewKind,
  IconButtonLink,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  StatusBadge,
  TextInput,
  Tooltip,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { RetentionFile, RetentionFileStatus, RetentionFilesResponse } from "../../../retention-policy-contracts";
import { errorMessage } from "../utils/api-helpers";

const PAGE_SIZE = 25;

const contentHref = (baseId: string, file: RetentionFile, inline = false): string => {
  const path = `/api/grids/bases/${encodeURIComponent(baseId)}/retention-policy/files/${encodeURIComponent(file.fileId)}/content`;
  return inline ? `${path}?inline=true` : path;
};

function RetentionFilePreviewDialog(props: { baseId: string; file: RetentionFile; close: () => void }) {
  const previewKind = () =>
    getFileViewPreviewKind({
      path: props.file.filename,
      mediaType: props.file.mimeType,
      size: props.file.sizeBytes,
    });
  const nativePreview = () => ["image", "pdf", "audio", "video"].includes(previewKind() ?? "");
  const preview = query.create({
    source: () => `${props.baseId}:${props.file.fileId}`,
    enabled: () => !nativePreview(),
    load: async (_, { abortSignal }): Promise<FileViewContent> => {
      const response = await fetch(contentHref(props.baseId, props.file, true), { signal: abortSignal });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load File preview"));
      return {
        encoding: "utf8",
        content: await response.text(),
        mediaType: response.headers.get("content-type")?.split(";", 1)[0] || props.file.mimeType,
      };
    },
  });
  const loaded = (): FileViewContent | null => preview.data() ?? null;
  const ready = () => nativePreview() || loaded() !== null;
  const downloadHref = () => contentHref(props.baseId, props.file);
  const previewHref = () => contentHref(props.baseId, props.file, true);

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.file.filename}
        subtitle={`${props.file.mimeType} · ${formatFileViewSize(props.file.sizeBytes)}`}
        icon={`ti ${fileIcons.getFileIcon({ name: props.file.filename, type: "file", mimeType: props.file.mimeType })}`}
        actions={
          <Tooltip.Anchor content="Download File">
            <IconButtonLink
              variant="ghost"
              size="sm"
              href={downloadHref()}
              download={props.file.filename}
              label={`Download ${props.file.filename}`}
            >
              <i class="ti ti-download" aria-hidden="true" />
            </IconButtonLink>
          </Tooltip.Anchor>
        }
        close={props.close}
      />
      <PanelDialog.Body>
        <Show when={nativePreview() || !preview.loading()} fallback={<Placeholder state="loading" title="Loading File preview" />}>
          <Show
            when={!preview.error() && ready()}
            fallback={
              <Placeholder
                state="error"
                title="File preview is unavailable"
                description={preview.error() instanceof Error ? preview.error()!.message : "Could not load File preview"}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void preview.refresh()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <FileView
              file={{
                path: props.file.filename,
                mediaType: props.file.mimeType,
                size: props.file.sizeBytes,
              }}
              load={() =>
                Promise.resolve(
                  loaded() ?? {
                    encoding: "base64",
                    content: "",
                    mediaType: props.file.mimeType,
                  },
                )
              }
              previewHref={previewHref()}
              downloadHref={downloadHref()}
              class="min-h-[24rem]"
            />
          </Show>
        </Show>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

const openPreview = (baseId: string, file: RetentionFile) =>
  dialogCore.open<void>(
    (close) => <RetentionFilePreviewDialog baseId={baseId} file={file} close={() => close()} />,
    panelDialogWorkspaceOptions,
  );

const columns: DataTableColumn<RetentionFile>[] = [
  { id: "file", header: "File", value: (row) => row.filename },
  { id: "size", header: "Size", value: (row) => row.sizeBytes, align: "right" },
  { id: "status", header: "Floor", value: (row) => row.status },
  { id: "notBefore", header: "Floor reached", value: (row) => row.notBefore },
  { id: "actions", header: "", align: "right" },
];

function RetentionFilesDialog(props: { baseId: string; minimumDays: number; close: () => void }) {
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load retained Files"));
      return response.json();
    },
  });
  const result = () => files.data();
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.pagination.total === 0) return "No Files";
    const start = (value.pagination.page - 1) * value.pagination.per_page + 1;
    const end = start + value.items.length - 1;
    return `${start}–${end} of ${value.pagination.total} Files`;
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Unreferenced Files"
        subtitle={`Preview for a ${props.minimumDays}-day retention floor`}
        icon="ti ti-file-search"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DataTable.Header title={rangeLabel()} size="sm">
            <Button size="sm" variant="secondary" disabled={files.loading() || files.refreshing()} onClick={() => void files.refresh()}>
              <i class={files.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> Refresh
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label="Search retained Files"
                placeholder="Search filename or File ID"
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
                label="Floor status"
                icon="ti ti-filter"
                options={[
                  {
                    options: [
                      { value: "all", label: "All Files" },
                      { value: "retained", label: "Retained until later" },
                      { value: "reached", label: "Floor reached" },
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
                title="Retained Files are unavailable"
                description={files.error() instanceof Error ? files.error()!.message : "Could not load retained Files"}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void files.refresh()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns}
              getRowId={(row) => row.fileId}
              ariaLabel="Unreferenced retained Files"
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                files.loading() ? (
                  <span>Loading retained Files…</span>
                ) : search() || status() !== "all" ? (
                  <span>No Files match these filters.</span>
                ) : (
                  <span>No unreferenced Files are currently tracked for this Base.</span>
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
                if (col.id === "size") return formatFileViewSize(row.sizeBytes);
                if (col.id === "status") {
                  return <StatusBadge tone="neutral" label={row.status === "retained" ? "Retained" : "Floor reached"} />;
                }
                if (col.id === "notBefore") return new Date(row.notBefore).toLocaleString();
                if (col.id === "actions") {
                  return (
                    <div class="flex justify-end gap-1">
                      <Show
                        when={canPreviewFile({
                          path: row.filename,
                          mediaType: row.mimeType,
                          size: row.sizeBytes,
                        })}
                      >
                        <Tooltip.Anchor content="View File">
                          <Button size="sm" variant="ghost" onClick={() => void openPreview(props.baseId, row)}>
                            <i class="ti ti-eye" aria-hidden="true" /> View
                          </Button>
                        </Tooltip.Anchor>
                      </Show>
                      <Tooltip.Anchor content="Download File">
                        <IconButtonLink
                          size="sm"
                          variant="ghost"
                          href={contentHref(props.baseId, row)}
                          download={row.filename}
                          label={`Download ${row.filename}`}
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
                Page {page()} of {result()?.pagination.total_pages}
              </span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={files.loading() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={files.loading() || !result()?.pagination.has_next}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </div>
            </DataTable.Footer>
          </Show>
        </DataTable.Panel>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openRetentionFilesDialog = (baseId: string, minimumDays: number) =>
  dialogCore.open<void>(
    (close) => <RetentionFilesDialog baseId={baseId} minimumDays={minimumDays} close={() => close()} />,
    panelDialogWorkspaceOptions,
  );
