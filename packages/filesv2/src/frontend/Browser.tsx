import { navigate as commitHistory, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { cookies } from "@k2b/stdlib/browser";
import { dropzone, mutation } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  Checkbox,
  ContextMenu,
  createCollectionSelection,
  DataTable,
  Dropdown,
  FileGrid,
  Format,
  IconButton,
  InlineGuidance,
  Placeholder,
  prompts,
  ScrollArea,
  SegmentedControl,
  TextInput,
  toast,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BasesResult, DirectoryResult, EntryResult, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { type BrowserPreferences, defaultPreferences, preferencesCookie } from "./browser-preferences";
import FileInspector from "./FileInspector";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { IssueMessage } from "./feedback";
import { apiFailure, contentLease } from "./file-preview";
import { useFilesMessages } from "./messages";
import { filesUrl, pathCrumbs } from "./urls";
import { UploadConflict, uploadFile } from "./uploads";

export default function Browser(props: {
  directory: DirectoryResult & { query?: string };
  after?: string;
  source?: string;
  detail?: EntryResult | null;
  preferences?: BrowserPreferences;
  pending?: boolean;
  error?: string;
  issues?: BasesResult["issues"];
  onSelectionSource?: (source: string) => void;
  onRetry?: () => void;
  onOpenDirectory?: (path: string) => void;
  onSearch?: (query: string | null) => void;
  onCreated?: (path: string) => void;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const [preferences, setPreferences] = createSignal(props.preferences ?? defaultPreferences);
  const updatePreferences = (next: Partial<BrowserPreferences>) => {
    const value = { ...preferences(), ...next };
    setPreferences(value);
    cookies.writeJsonCookie(preferencesCookie, value);
  };
  const requestedFile = () => (props.source ? new URL(props.source, "https://files.invalid").searchParams.get("file") : null);
  const [externalPath, setExternalPath] = createSignal(requestedFile());
  const [touch, setTouch] = createSignal(false);
  const [selectMode, setSelectMode] = createSignal(false);
  let mounted = false;
  let syncing = false;
  let location = `${props.directory.base.id}:${props.directory.path}:${props.after ?? ""}`;
  let lastSource = props.source;
  const ids = () => [...new Set([...props.directory.items.map((item) => item.path), ...(externalPath() ? [externalPath()!] : [])])];
  const selection = createCollectionSelection({
    ids,
    initial: requestedFile() ? [requestedFile()!] : [],
    onChange: (paths) => {
      if (!mounted || syncing || location !== `${props.directory.base.id}:${props.directory.path}:${props.after ?? ""}`) return;
      const source = filesUrl(
        props.directory.base.id,
        props.directory.path,
        props.after,
        paths.length === 1 ? paths[0] : null,
        props.directory.query,
      );
      commitHistory(source, {
        replace: true,
        scroll: "manual",
        viewTransition: false,
      });
      props.onSelectionSource?.(source);
    },
  });
  onMount(() => {
    mounted = true;
    const media = window.matchMedia("(pointer: coarse)");
    const change = () => setTouch(media.matches);
    change();
    media.addEventListener("change", change);
    onCleanup(() => media.removeEventListener("change", change));
  });
  createEffect(() => {
    const next = `${props.directory.base.id}:${props.directory.path}:${props.after ?? ""}`;
    const source = props.source;
    if (next !== location || source !== lastSource) {
      syncing = true;
      setExternalPath(requestedFile());
      selection.replace(requestedFile() ? [requestedFile()!] : []);
      syncing = false;
      location = next;
      lastSource = source;
    }
  });
  // In touch selection mode a plain tap toggles membership instead of replacing the selection.
  const rowSelection = {
    ...selection,
    select: (id: string, modifiers?: Parameters<typeof selection.select>[1]) =>
      touch() && selectMode() ? selection.toggle(id) : selection.select(id, modifiers),
  };
  const selectedPaths = createMemo(() => [...selection.selected()]);
  const selected = createMemo(() => props.directory.items.filter((item) => selection.selected().has(item.path)));
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  const download = mutation.create({
    mutation: async (entries: readonly FileEntry[], { abortSignal }) => {
      const baseId = props.directory.base.id;
      setProgress({ done: 0, total: entries.length });
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const lease = await contentLease(baseId, entry.path, abortSignal, t().downloadFailed);
        abortSignal.throwIfAborted();
        const link = document.createElement("a");
        link.href = lease.url;
        link.download = entry.name;
        link.rel = "noreferrer";
        document.body.append(link);
        link.click();
        link.remove();
        setProgress({ done: index + 1, total: entries.length });
      }
    },
  });
  onCleanup(() => download.abort());
  const startDownload = (entries: readonly FileEntry[]) => {
    if (!props.pending && !download.loading() && entries.length && entries.every((entry) => !entry.directory))
      void download.mutate(entries);
  };
  const open = (entry: FileEntry) => {
    if (props.pending) return;
    if (entry.directory) {
      // The click that precedes opening selected the folder; history must not return to that selection.
      selection.clear();
      props.onOpenDirectory?.(entry.path);
      return;
    }
    void prompts.dialog(() => <FilePreview baseId={props.directory.base.id} entry={entry} onDownload={() => startDownload([entry])} />, {
      title: entry.name,
      size: "large",
    });
  };
  const focusContext = (entry: FileEntry) => {
    if (!selection.selected().has(entry.path)) selection.select(entry.path);
  };
  const canDownload = () => selected().length > 0 && selected().every((entry) => !entry.directory) && !download.loading() && !props.pending;
  const menuItems = () => [
    ...(selected().length === 1 ? [{ label: b().open, icon: "ti ti-external-link", action: () => open(selected()[0]!) }] : []),
    { label: b().downloadSelection, icon: "ti ti-download", disabled: !canDownload(), action: () => startDownload(selected()) },
    { label: b().selectAll, icon: "ti ti-checks", action: () => selection.replace(props.directory.items.map((entry) => entry.path)) },
    { label: b().clear, icon: "ti ti-x", action: selection.clear },
  ];
  const rowActions = (entry: FileEntry) => (
    <div class="flex items-center gap-1">
      <Show
        when={entry.directory}
        fallback={
          <IconButton
            size="sm"
            variant="ghost"
            label={`${t().download}: ${entry.name}`}
            disabled={props.pending || download.loading()}
            onClick={() => startDownload([entry])}
          >
            <i class="ti ti-download" aria-hidden="true" />
          </IconButton>
        }
      >
        <ButtonLink
          href={filesUrl(props.directory.base.id, entry.path)}
          navigation="enhanced"
          onNavigate={props.onNavigate}
          size="sm"
          variant="ghost"
          aria-label={`${b().open}: ${entry.name}`}
        >
          <i class="ti ti-folder-open" aria-hidden="true" />
        </ButtonLink>
      </Show>
      <Dropdown.Root
        items={[
          { label: b().open, icon: "ti ti-external-link", action: () => open(entry) },
          { label: b().details, icon: "ti ti-info-circle", action: () => selection.select(entry.path) },
        ]}
      >
        <Dropdown.Trigger iconOnly label={`${t().actions}: ${entry.name}`} size="sm" variant="ghost">
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </div>
  );
  const checkbox = (entry: FileEntry) => (
    <Checkbox
      value={selection.selected().has(entry.path)}
      label={
        <span class="sr-only">
          {b().select}: {entry.name}
        </span>
      }
      onValueChange={() => {
        if (touch()) setSelectMode(true);
        selection.toggle(entry.path);
      }}
    />
  );
  const [uploadProgress, setUploadProgress] = createSignal<{ done: number; total: number; name: string; percent: number } | null>(null);
  const upload = mutation.create({
    mutation: async (files: readonly File[], { abortSignal }) => {
      const baseId = props.directory.base.id;
      const folder = props.directory.path;
      let uploaded = 0;
      let last: string | null = null;
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        const path = folder ? `${folder}/${file.name}` : file.name;
        const progress = (bytes: number) =>
          setUploadProgress({
            done: index,
            total: files.length,
            name: file.name,
            percent: file.size ? Math.floor((bytes / file.size) * 100) : 100,
          });
        progress(0);
        let onConflict: "error" | "overwrite" = "error";
        for (;;) {
          try {
            const result = await uploadFile(baseId, path, file, {
              onConflict,
              signal: abortSignal,
              fallback: b().uploadFailed(file.name),
              onProgress: progress,
            });
            uploaded++;
            last = result.entry.path;
            break;
          } catch (error) {
            if (error instanceof UploadConflict && onConflict === "error") {
              const replace = await prompts.confirm(b().replaceQuestion(error.fileName), {
                title: b().replaceTitle,
                confirmText: b().replace,
                cancelText: b().skip,
                variant: "danger",
              });
              abortSignal.throwIfAborted();
              if (replace) {
                onConflict = "overwrite";
                continue;
              }
              break;
            }
            if (abortSignal.aborted) throw error;
            toast.error(error instanceof Error && error.message !== "path_conflict" ? error.message : b().uploadFailed(file.name));
            break;
          }
        }
      }
      setUploadProgress(null);
      if (uploaded) {
        toast.success(b().uploaded(uploaded));
        props.onCreated?.(last!);
      }
    },
  });
  onCleanup(() => upload.abort());
  const startUpload = (files: readonly File[]) => {
    if (files.length && !props.pending && !upload.loading() && !searching()) void upload.mutate(files);
  };
  let picker: HTMLInputElement | undefined;
  const drop = dropzone.create({ onDrop: startUpload });
  const createFile = async () => {
    const values = await prompts.form({
      title: b().newFile,
      fields: {
        name: {
          type: "text",
          label: b().newFileName,
          required: true,
          maxLength: 255,
          validate: (value) =>
            value && !value.includes("/") && value.trim() === value && value !== "." && value !== ".." ? null : b().newFolderInvalid,
        },
      },
    });
    if (values) startUpload([new File([], values.name)]);
  };
  const columns = () => [
    {
      id: "select",
      header: (
        <Checkbox
          value={selected().length === props.directory.items.length && selected().length > 0}
          indeterminate={selected().length > 0 && selected().length < props.directory.items.length}
          label={<span class="sr-only">{b().selectAll}</span>}
          onValueChange={(value) => (value ? selection.replace(props.directory.items.map((entry) => entry.path)) : selection.clear())}
        />
      ),
      class: "w-10",
    },
    { id: "name", header: t().name },
    ...(searching() ? [{ id: "folder", header: b().parentFolder, class: "filesv2-modified-column" }] : []),
    { id: "size", header: t().size, align: "right" as const },
    { id: "modified", header: t().modified, class: "filesv2-modified-column" },
    { id: "actions", header: <span class="sr-only">{t().actions}</span>, align: "right" as const },
  ];
  const refreshHref = () =>
    filesUrl(
      props.directory.base.id,
      props.directory.path,
      props.after,
      selectedPaths().length === 1 ? selectedPaths()[0] : null,
      props.directory.query,
    );
  const searching = () => !!props.directory.query;
  const [searchText, setSearchText] = createSignal(props.directory.query ?? "");
  createEffect(() => setSearchText(props.directory.query ?? ""));
  const submitSearch = () => {
    const value = searchText().trim();
    if (value !== (props.directory.query ?? "")) props.onSearch?.(value || null);
  };
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/") || props.directory.base.name;
  const createFolder = async () => {
    const values = await prompts.form({
      title: b().newFolder,
      fields: {
        name: {
          type: "text",
          label: b().newFolderName,
          required: true,
          maxLength: 255,
          validate: (value) =>
            value && !value.includes("/") && value.trim() === value && value !== "." && value !== ".." ? null : b().newFolderInvalid,
        },
      },
    });
    if (!values) return;
    const path = props.directory.path ? `${props.directory.path}/${values.name}` : values.name;
    try {
      const response = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: props.directory.base.id }, json: { path } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().folderCreated(values.name));
      props.onCreated?.(path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().unavailable);
    }
  };
  const pageKey = () => `filesv2:${props.directory.base.id}:${props.directory.path}:${props.after ?? ""}:${preferences().view}`;
  return (
    <>
      <AppWorkspace.Main scroll={false} class="filesv2-browser" aria-busy={props.pending}>
        <div class="filesv2-browser__surface" {...drop.handlers}>
          <Show when={drop.isDragging() && !searching()}>
            <div class="filesv2-browser__drop" aria-hidden="true">
              <i class="ti ti-upload" />
              {b().dropHere}
            </div>
          </Show>
          <header class="filesv2-browser__header">
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <nav aria-label={t().breadcrumbs} class="min-w-0">
                <ol class="flex min-w-0 flex-wrap items-center gap-1">
                  <li>
                    <ButtonLink
                      href={filesUrl(props.directory.base.id)}
                      navigation="enhanced"
                      onNavigate={props.onNavigate}
                      variant="text"
                      size="sm"
                      aria-current={props.directory.path ? undefined : "page"}
                    >
                      {props.directory.base.name}
                    </ButtonLink>
                  </li>
                  <For each={pathCrumbs(props.directory.path)}>
                    {(crumb) => (
                      <li class="flex min-w-0 items-center gap-1">
                        <span aria-hidden="true" class="text-dimmed">
                          /
                        </span>
                        <ButtonLink
                          href={filesUrl(props.directory.base.id, crumb.path)}
                          navigation="enhanced"
                          onNavigate={props.onNavigate}
                          variant="text"
                          size="sm"
                          aria-current={crumb.path === props.directory.path ? "page" : undefined}
                        >
                          {crumb.name}
                        </ButtonLink>
                      </li>
                    )}
                  </For>
                </ol>
              </nav>
              <div class="flex min-w-0 flex-wrap items-center gap-1">
                <TextInput
                  type="search"
                  size="sm"
                  icon="ti ti-search"
                  placeholder={b().search}
                  aria-label={b().searchIn(props.directory.path.split("/").at(-1) || props.directory.base.name)}
                  value={searchText()}
                  onValueChange={setSearchText}
                  onSubmit={submitSearch}
                  onBlur={submitSearch}
                  clearable
                  clearLabel={b().clearSearch}
                  onClear={() => {
                    setSearchText("");
                    if (searching()) props.onSearch?.(null);
                  }}
                  class="filesv2-search"
                />
                <Show when={!searching()}>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    class="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(event) => {
                      startUpload(Array.from(event.currentTarget.files ?? []));
                      event.currentTarget.value = "";
                    }}
                  />
                  <Button size="sm" variant="primary" disabled={props.pending || upload.loading()} onClick={() => picker?.click()}>
                    <i class="ti ti-upload" aria-hidden="true" />
                    {b().upload}
                  </Button>
                  <Dropdown.Root
                    items={[
                      { label: b().newFolder, icon: "ti ti-folder-plus", action: () => void createFolder() },
                      { label: b().newFile, icon: "ti ti-file-plus", action: () => void createFile() },
                    ]}
                  >
                    <Dropdown.Trigger
                      iconOnly
                      label={b().newFolder}
                      size="sm"
                      variant="secondary"
                      disabled={props.pending || upload.loading()}
                    >
                      <i class="ti ti-plus" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </Show>
                <Show when={touch()}>
                  <Button size="xs" variant="secondary" onClick={() => setSelectMode(!selectMode())}>
                    {selectMode() ? b().endSelect : b().selectMode}
                  </Button>
                </Show>
                <span class="flex shrink-0 items-center gap-1">
                  <SegmentedControl
                    label={b().view}
                    size="sm"
                    value={preferences().view}
                    options={[
                      { value: "list", label: b().list, icon: "ti ti-list" },
                      { value: "grid", label: b().grid, icon: "ti ti-grid-dots" },
                    ]}
                    onValueChange={(view) => updatePreferences({ view })}
                  />
                  <Dropdown.Root
                    items={
                      preferences().view === "list"
                        ? [
                            {
                              label: b().normal,
                              icon: preferences().density === "normal" ? "ti ti-check" : "ti ti-layout-rows",
                              action: () => updatePreferences({ density: "normal" }),
                            },
                            {
                              label: b().compact,
                              icon: preferences().density === "compact" ? "ti ti-check" : "ti ti-layout-rows",
                              action: () => updatePreferences({ density: "compact" }),
                            },
                          ]
                        : [
                            { label: b().small, action: () => updatePreferences({ size: "sm" }) },
                            { label: b().medium, action: () => updatePreferences({ size: "md" }) },
                            { label: b().large, action: () => updatePreferences({ size: "lg" }) },
                          ]
                    }
                  >
                    <Dropdown.Trigger iconOnly label={b().options} size="sm" variant="ghost">
                      <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                  <ButtonLink
                    href={refreshHref()}
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    size="sm"
                    variant="ghost"
                    aria-label={t().refresh}
                  >
                    <i class="ti ti-refresh" aria-hidden="true" />
                  </ButtonLink>
                </span>
              </div>
            </div>
            <div class="filesv2-selection-bar">
              <span class="text-xs text-dimmed">
                {searching() ? b().searchResults(props.directory.items.length) : b().pageItems(props.directory.items.length)}
              </span>
              <Show when={selectedPaths().length}>
                <span aria-hidden="true" class="text-xs text-dimmed">
                  ·
                </span>
                <span class="text-xs font-medium" role="status">
                  {b().selected(selectedPaths().length)}
                </span>
                <Button size="xs" variant="secondary" disabled={!canDownload()} onClick={() => startDownload(selected())}>
                  <i class="ti ti-download" aria-hidden="true" />
                  {t().download}
                </Button>
                <Button size="xs" variant="ghost" onClick={selection.clear}>
                  {b().clear}
                </Button>
              </Show>
            </div>
            <For each={props.issues}>
              {(issue) => (
                <InlineGuidance tone="info">
                  <strong>{t()[issue.area]}: </strong>
                  <IssueMessage code={issue.code} />
                </InlineGuidance>
              )}
            </For>
            <Show when={props.pending}>
              <InlineGuidance loading>{t().loadingFiles}</InlineGuidance>
            </Show>
            <Show when={props.error}>
              <InlineGuidance tone="danger" role="alert">
                {props.error}{" "}
                <Button size="xs" variant="text" onClick={props.onRetry}>
                  {b().retry}
                </Button>
              </InlineGuidance>
            </Show>
            <Show when={download.error()}>
              {(error) => (
                <InlineGuidance tone="danger" role="alert">
                  {error().message}
                </InlineGuidance>
              )}
            </Show>
            <Show when={download.loading()}>
              <InlineGuidance loading>
                {b().downloadProgress(progress())}{" "}
                <Button size="xs" variant="text" onClick={() => download.abort()}>
                  {b().cancel}
                </Button>
              </InlineGuidance>
            </Show>
            <Show when={progress().total > 1}>
              <InlineGuidance tone="info">{b().downloadNotice}</InlineGuidance>
            </Show>
            <Show when={uploadProgress()}>
              {(state) => (
                <InlineGuidance loading role="status">
                  {b().uploading(state())}{" "}
                  <Button size="xs" variant="text" onClick={() => upload.abort()}>
                    {b().cancel}
                  </Button>
                </InlineGuidance>
              )}
            </Show>
          </header>
          <Show
            when={props.directory.items.length}
            fallback={
              <Placeholder
                class="flex-1"
                variant="panel"
                icon={searching() ? "ti ti-search-off" : "ti ti-folder"}
                title={searching() ? b().noResultsTitle : b().emptyTitle}
                description={searching() ? b().noResultsDescription : b().emptyDescription}
              />
            }
          >
            <ContextMenu class="filesv2-browser__collection" tabIndex={-1} items={menuItems()} label={t().actions} disabled={props.pending}>
              <Show
                when={preferences().view === "list"}
                fallback={
                  <ScrollArea class="h-full" scrollPreserveKey={pageKey()}>
                    <FileGrid
                      rows={props.directory.items}
                      getRowId={(row) => row.path}
                      selection={rowSelection}
                      label={t().files}
                      size={preferences().size}
                      onOpen={open}
                      onContextMenu={focusContext}
                      onRowClick={(row) => {
                        if (touch() && !selectMode() && row.directory) open(row);
                      }}
                      renderPreview={(row) => <FileThumbnail baseId={props.directory.base.id} entry={row} large />}
                      renderLabel={(row) => <span title={row.name}>{row.name}</span>}
                      renderMeta={(row) =>
                        searching() ? (
                          <span title={parentOf(row.path)}>{parentOf(row.path)}</span>
                        ) : row.directory ? (
                          b().folder
                        ) : (
                          <Format.Bytes value={row.size} />
                        )
                      }
                      renderActions={(row) => (
                        <>
                          {checkbox(row)}
                          {rowActions(row)}
                        </>
                      )}
                    />
                  </ScrollArea>
                }
              >
                <DataTable
                  rows={props.directory.items}
                  columns={columns()}
                  getRowId={(row) => row.path}
                  selection={rowSelection}
                  onRowDoubleClick={open}
                  onRowContextMenu={focusContext}
                  onRowClick={(row) => {
                    if (touch() && !selectMode() && row.directory) open(row);
                  }}
                  ariaLabel={t().files}
                  class="h-full"
                  surface="plain"
                  density={preferences().density}
                  highlightColumns={false}
                  scrollPreserveKey={pageKey()}
                  renderCell={({ row, col }) => {
                    if (col.id === "select") return checkbox(row);
                    if (col.id === "name")
                      return (
                        <div class="flex min-w-0 items-center gap-2">
                          <FileThumbnail baseId={props.directory.base.id} entry={row} />
                          <span class="filesv2-filename" title={row.name}>
                            {row.name}
                          </span>
                        </div>
                      );
                    if (col.id === "folder") return <span class="text-dimmed">{parentOf(row.path)}</span>;
                    if (col.id === "size") return row.directory ? "—" : <Format.Bytes value={row.size} />;
                    if (col.id === "modified") return <Format.DateTime value={row.modified} />;
                    return rowActions(row);
                  }}
                />
              </Show>
            </ContextMenu>
          </Show>
          <nav class="filesv2-browser__pagination" aria-label={t().files}>
            <Show when={props.after}>
              <ButtonLink
                href={filesUrl(props.directory.base.id, props.directory.path, null, null, props.directory.query)}
                navigation="enhanced"
                onNavigate={props.onNavigate}
                size="sm"
                variant="secondary"
              >
                {t().first}
              </ButtonLink>
            </Show>
            <Show when={props.directory.next}>
              {(next) => (
                <ButtonLink
                  href={filesUrl(props.directory.base.id, props.directory.path, next(), null, props.directory.query)}
                  navigation="enhanced"
                  onNavigate={props.onNavigate}
                  size="sm"
                  variant="secondary"
                >
                  {t().next}
                  <i class="ti ti-chevron-right" aria-hidden="true" />
                </ButtonLink>
              )}
            </Show>
          </nav>
        </div>
      </AppWorkspace.Main>
      <AppWorkspace.Detail id="filesv2-inspector" open={selectedPaths().length > 0 && !(touch() && selectMode())} width="md">
        <Show when={selectedPaths().length > 0 && !(touch() && selectMode())}>
          <FileInspector
            base={props.directory.base}
            paths={selectedPaths()}
            selected={selected()}
            initial={props.detail}
            onClose={() => {
              const focused = selection.focused();
              selection.clear();
              if (focused) selection.focus(focused);
            }}
            onOpen={open}
            onDownload={startDownload}
          />
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
