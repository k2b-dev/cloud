import { downloadArchive } from "@k2b/filegate/utils";
import { navigate as commitHistory, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { cookies } from "@k2b/stdlib/browser";
import { dropzone, mutation } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  ContextMenu,
  createCollectionSelection,
  Dropdown,
  FileGrid,
  Format,
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
import type { BaseSummary, BasesResult, DirectoryResult, EntryResult, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { folderKey, preferencesCookie, type ViewPreference, viewFor, withView } from "./browser-preferences";
import FileInspector from "./FileInspector";
import FileList, { type FileRow } from "./FileList";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { IssueMessage } from "./feedback";
import { apiFailure, contentLease } from "./file-preview";
import { useFilesMessages } from "./messages";
import { openDestinationDialog } from "./MoveDialog";
import { filesUrl } from "./urls";
import { UploadConflict, uploadFile } from "./uploads";

type Directory = DirectoryResult & { query?: string };
type Branch = { items: FileEntry[]; next: string | null; loading: boolean; error: boolean };
const nameValid = (value: string | undefined) =>
  !!value && !value.includes("/") && value.trim() === value && value !== "." && value !== "..";
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

export default function Browser(props: {
  directory: Directory;
  bases: readonly BaseSummary[];
  cloudUrl: string;
  after?: string;
  source?: string;
  detail?: EntryResult | null;
  preferences?: Record<string, ViewPreference>;
  pending?: boolean;
  error?: string;
  issues?: BasesResult["issues"];
  onSelectionSource?: (source: string) => void;
  onRetry?: () => void;
  onOpenDirectory?: (path: string) => void;
  onSearch?: (query: string | null) => void;
  onChanged?: (selectPath?: string | null) => void;
  onShare?: (paths: readonly string[]) => void;
  onShareInbox?: (folder: string) => void;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const baseId = () => props.directory.base.id;
  const folder = () => props.directory.path;
  const searching = () => !!props.directory.query;
  // View settings belong to one folder; a cookie remembers the latest folders.
  const [preferences, setPreferences] = createSignal(props.preferences ?? {});
  const view = createMemo(() =>
    searching() ? { ...viewFor(preferences(), baseId(), folder()), view: "list" as const } : viewFor(preferences(), baseId(), folder()),
  );
  const updateView = (next: Partial<ViewPreference>) => {
    const value = withView(preferences(), baseId(), folder(), { ...viewFor(preferences(), baseId(), folder()), ...next });
    setPreferences(value);
    cookies.writeJsonCookie(preferencesCookie, value);
  };
  const requestedFile = () => (props.source ? new URL(props.source, "https://files.invalid").searchParams.get("file") : null);
  const [externalPath, setExternalPath] = createSignal(requestedFile());
  const [touch, setTouch] = createSignal(false);
  // The folder being opened shows a spinner in place of its icon; nothing else moves.
  const [opening, setOpening] = createSignal<string | null>(null);
  let mounted = false;
  let syncing = false;
  const locationKey = () => `${baseId()}:${folder()}:${props.after ?? ""}:${props.directory.query ?? ""}`;
  let location = locationKey();
  let lastSource = props.source;

  // Tree view keeps opened folders in place; children are loaded on demand and the current folder's own listing is reused.
  const [branches, setBranches] = createSignal<Record<string, Branch>>({});
  const branch = (path: string) => branches()[path];
  const setBranch = (path: string, value: Branch | null) =>
    setBranches((current) => {
      const next = { ...current };
      if (value) next[path] = value;
      else delete next[path];
      return next;
    });
  const loadBranch = async (path: string, after?: string | null) => {
    const previous = branch(path);
    setBranch(path, { items: after ? (previous?.items ?? []) : (previous?.items ?? []), next: null, loading: true, error: false });
    try {
      const response = await apiClient.bases[":baseId"].entries.$get({
        param: { baseId: baseId() },
        query: { path, after: after ?? undefined },
      });
      if (!response.ok) throw new Error();
      const page = await response.json();
      setBranch(path, { items: [...(after ? (previous?.items ?? []) : []), ...page.items], next: page.next, loading: false, error: false });
    } catch {
      setBranch(path, { items: previous?.items ?? [], next: null, loading: false, error: true });
    }
  };
  const toggleBranch = (row: FileRow) => {
    if (branch(row.path)) setBranch(row.path, null);
    else void loadBranch(row.path);
  };
  createEffect(() => {
    // Tree mode always starts at the storage root and is expanded down to the current folder.
    if (view().view !== "tree" || searching()) return;
    const current = folder();
    setBranch(current, { items: props.directory.items, next: props.directory.next, loading: false, error: false });
    for (const path of ["", ...ancestors(current)]) if (path !== current && !branch(path)) void loadBranch(path);
  });
  const rows = createMemo<FileRow[]>(() => {
    if (view().view !== "tree" || searching()) return props.directory.items;
    const out: FileRow[] = [];
    const walk = (items: readonly FileEntry[], depth: number) => {
      for (const item of items) {
        const open = item.directory ? branch(item.path) : undefined;
        out.push({ ...item, depth, expanded: !!open, loading: open?.loading });
        if (open) {
          walk(open.items, depth + 1);
          if (open.next) out.push({ ...item, path: `${item.path} more`, name: "", more: true, depth: depth + 1 });
        }
      }
    };
    walk(folder() ? (branch("")?.items ?? []) : props.directory.items, 0);
    return out;
  });
  const entries = createMemo(() => rows().filter((row) => !row.more));
  const ids = () => [...new Set([...entries().map((row) => row.path), ...(externalPath() ? [externalPath()!] : [])])];
  const selection = createCollectionSelection({
    ids,
    initial: requestedFile() ? [requestedFile()!] : [],
    onChange: (paths) => {
      if (!mounted || syncing || location !== locationKey()) return;
      const source = filesUrl(baseId(), folder(), props.after, paths.length === 1 ? paths[0] : null, props.directory.query);
      commitHistory(source, { replace: true, scroll: "manual", viewTransition: false });
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
    const next = locationKey();
    const source = props.source;
    if (next !== location || source !== lastSource) {
      syncing = true;
      setExternalPath(requestedFile());
      selection.replace(requestedFile() ? [requestedFile()!] : []);
      syncing = false;
      if (next !== location) {
        setBranches({});
        setOpening(null);
      }
      location = next;
      lastSource = source;
    }
  });
  createEffect(() => {
    if (!props.pending && props.error) setOpening(null);
  });
  const selectedPaths = createMemo(() => [...selection.selected()]);
  const selected = createMemo(() => entries().filter((row) => selection.selected().has(row.path)));
  const busy = () => !!props.pending || download.loading() || upload.loading() || action.loading();
  const refresh = (selectPath?: string | null) => props.onChanged?.(selectPath);
  const openFolder = (path: string) => {
    setOpening(path);
    selection.clear();
    props.onOpenDirectory?.(path);
  };

  // Downloads: one file through its lease, anything else as a signed archive.
  const download = mutation.create({
    mutation: async (items: readonly FileEntry[], { abortSignal }) => {
      if (items.length === 1 && !items[0]!.directory) {
        const lease = await contentLease(baseId(), items[0]!.path, abortSignal, t().downloadFailed);
        const link = document.createElement("a");
        link.href = lease.url;
        link.download = items[0]!.name;
        link.rel = "noreferrer";
        document.body.append(link);
        link.click();
        link.remove();
        return;
      }
      const response = await apiClient.bases[":baseId"].archive.$post(
        { param: { baseId: baseId() }, json: { paths: items.map((item) => item.path) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().downloadFailed);
      downloadArchive(await response.json());
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => download.abort());
  const startDownload = (items: readonly FileEntry[]) => {
    if (items.length && !busy()) void download.mutate(items);
  };

  // Uploads: Cloud opens a Filegate session per file; folders are recreated from relative paths first.
  const [uploadProgress, setUploadProgress] = createSignal<{ done: number; total: number; name: string; percent: number } | null>(null);
  const upload = mutation.create({
    mutation: async (files: readonly File[], { abortSignal }) => {
      const base = baseId();
      const root = folder();
      const folders = new Set<string>();
      for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
        const parts = relative.split("/").slice(0, -1);
        for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      }
      for (const path of [...folders].sort()) {
        const response = await apiClient.bases[":baseId"].directories.$post(
          { param: { baseId: base }, json: { path: root ? `${root}/${path}` : path } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok && (response.status as number) !== 409) await apiFailure(response, t().unavailable);
      }
      let uploaded = 0;
      let last: string | null = null;
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const path = root ? `${root}/${relative}` : relative;
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
            const result = await uploadFile(base, path, file, {
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
        refresh(last);
      }
    },
  });
  onCleanup(() => upload.abort());
  const startUpload = (files: readonly File[]) => {
    if (files.length && !busy() && !searching()) void upload.mutate(files);
  };
  let filePicker: HTMLInputElement | undefined;
  let folderPicker: HTMLInputElement | undefined;
  const drop = dropzone.create({ onDrop: startUpload });

  // Mutations on the selection run through one loading state and one error surface.
  const action = mutation.create({
    mutation: async (run: () => Promise<void>) => run(),
    onError: (error) => toast.error(error.message),
  });
  const runAction = (run: () => Promise<void>) => {
    if (!busy()) void action.mutate(run);
  };
  // Every name prompt says where the entry will live, which matters most in tree view.
  const askName = (title: string, label: string, initial = "") =>
    prompts
      .form({
        title,
        fields: {
          location: {
            type: "info",
            content: () => (
              <InlineGuidance icon="ti ti-folder">
                <span class="break-all">{`${props.directory.base.name} / ${folder()}`.replace(/ \/ $/, "")}</span>
              </InlineGuidance>
            ),
          },
          name: {
            type: "text",
            label,
            required: true,
            maxLength: 255,
            default: initial,
            validate: (value) => (nameValid(value) ? null : b().newFolderInvalid),
          },
        },
      })
      .then((values) => (values ? String(values.name) : null));
  const createFolder = async () => {
    const name = await askName(b().newFolder, b().newFolderName);
    if (!name) return;
    const path = folder() ? `${folder()}/${name}` : name;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: baseId() }, json: { path } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().folderCreated(name));
      refresh(path);
    });
  };
  const createFile = async () => {
    const name = await askName(b().newFile, b().newFileName);
    if (name) startUpload([new File([], name)]);
  };
  const moveIntoNewFolder = async (items: readonly FileEntry[]) => {
    const name = await askName(b().moveToNewFolder, b().newFolderName);
    if (!name) return;
    const path = folder() ? `${folder()}/${name}` : name;
    runAction(async () => {
      const made = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: baseId() }, json: { path } });
      if (!made.ok) await apiFailure(made, t().unavailable);
      const moved = await apiClient.bases[":baseId"].move.$post({
        param: { baseId: baseId() },
        json: { paths: items.map((item) => item.path), folder: path },
      });
      if (!moved.ok) await apiFailure(moved, t().unavailable);
      toast.success(b().moved(items.length));
      refresh(path);
    });
  };
  const moveOrCopy = async (items: readonly FileEntry[], copyOnly = false) => {
    const destination = await openDestinationDialog({
      bases: props.bases,
      sourceBaseId: baseId(),
      sourcePaths: items.map((item) => item.path),
      initialFolder: folder(),
      copyOnly,
    });
    if (!destination) return;
    runAction(async () => {
      const paths = items.map((item) => item.path);
      const response = destination.copy
        ? await apiClient.bases[":baseId"].copy.$post({
            param: { baseId: baseId() },
            json: { paths, targetBaseId: destination.baseId, folder: destination.folder },
          })
        : await apiClient.bases[":baseId"].move.$post({ param: { baseId: baseId() }, json: { paths, folder: destination.folder } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(destination.copy ? b().copied(items.length) : b().moved(items.length));
      refresh(null);
    });
  };
  const trashItems = async (items: readonly FileEntry[]) => {
    const confirmed = await prompts.confirm(b().moveTrashQuestion({ n: items.length, name: items[0]?.name ?? "" }), {
      title: b().moveTrashTitle,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: b().trashSelection,
    });
    if (!confirmed) return;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].delete.$post({
        param: { baseId: baseId() },
        json: { paths: items.map((item) => item.path) },
      });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().trashed(items.length));
      refresh(null);
    });
  };
  const rename = async (item: FileEntry) => {
    const name = await askName(b().rename, b().newName, item.name);
    if (!name || name === item.name) return;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].rename.$post({ param: { baseId: baseId() }, json: { path: item.path, name } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().renamed);
      refresh((await response.json()).entry.path);
    });
  };
  const duplicate = (item: FileEntry) =>
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].copy.$post({
        param: { baseId: baseId() },
        json: { paths: [item.path], targetBaseId: baseId(), folder: parentPath(item.path) },
      });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().duplicated);
      refresh((await response.json()).entries[0]?.path ?? null);
    });

  const open = (entry: FileEntry) => {
    if (busy()) return;
    if (entry.directory) {
      openFolder(entry.path);
      return;
    }
    void prompts.dialog(() => <FilePreview baseId={baseId()} entry={entry} onDownload={() => startDownload([entry])} />, {
      title: entry.name,
      size: "large",
    });
  };
  const rowClick = (row: FileRow, event: MouseEvent) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      selection.select(row.path, event);
      return;
    }
    if (row.directory && !searching()) {
      if (view().view === "tree") toggleBranch(row);
      else open(row);
      return;
    }
    if (row.directory) {
      openFolder(row.path);
      return;
    }
    selection.select(row.path);
  };
  const focusContext = (entry: FileEntry) => {
    if (!selection.selected().has(entry.path)) selection.select(entry.path);
  };
  const selectionItems = () => {
    const items = selected();
    return [
      {
        label: items.length === 1 && !items[0]!.directory ? t().download : b().downloadZip,
        icon: "ti ti-download",
        action: () => startDownload(items),
      },
      ...(searching()
        ? []
        : [
            { label: b().moveToNewFolder, icon: "ti ti-folder-plus", action: () => void moveIntoNewFolder(items) },
            { label: b().moveTo, icon: "ti ti-arrow-move-right", action: () => void moveOrCopy(items) },
            { label: b().copyTo, icon: "ti ti-copy", action: () => void moveOrCopy(items, true) },
          ]),
      ...(props.onShare
        ? [{ label: b().shareSelection, icon: "ti ti-world-share", action: () => props.onShare?.(items.map((item) => item.path)) }]
        : []),
      { label: b().clear, icon: "ti ti-x", action: selection.clear },
      { items: [{ label: b().trashSelection, icon: "ti ti-trash", variant: "danger" as const, action: () => void trashItems(items) }] },
    ];
  };
  const contextItems = () => {
    const items = selected();
    if (items.length !== 1) return selectionItems();
    const item = items[0]!;
    return [
      { label: b().open, icon: item.directory ? "ti ti-folder-open" : "ti ti-eye", action: () => open(item) },
      { label: b().details, icon: "ti ti-info-circle", action: () => selection.select(item.path) },
      ...(searching()
        ? []
        : [
            { label: b().rename, icon: "ti ti-pencil", action: () => void rename(item) },
            { label: b().duplicate, icon: "ti ti-copy", action: () => duplicate(item) },
          ]),
      ...selectionItems(),
    ];
  };

  const [searchText, setSearchText] = createSignal(props.directory.query ?? "");
  createEffect(() => setSearchText(props.directory.query ?? ""));
  const submitSearch = () => {
    const value = searchText().trim();
    if (value !== (props.directory.query ?? "")) props.onSearch?.(value || null);
  };
  const parentOf = (path: string) => parentPath(path) || props.directory.base.name;
  const detailOpen = () => selectedPaths().length > 0;
  const addItems = () => [
    { label: b().upload, icon: "ti ti-upload", action: () => filePicker?.click() },
    { label: b().uploadFolder, icon: "ti ti-folder-up", action: () => folderPicker?.click() },
    {
      items: [
        { label: b().newFolder, icon: "ti ti-folder-plus", action: () => void createFolder() },
        { label: b().newFile, icon: "ti ti-file-plus", action: () => void createFile() },
      ],
    },
  ];
  return (
    <>
      <AppWorkspace.Main scroll={false} class="filesv2-browser" aria-busy={props.pending}>
        <div class="filesv2-browser__surface" data-dragging={drop.isDragging() && !searching() ? "true" : undefined} {...drop.handlers}>
          <Show when={drop.isDragging() && !searching()}>
            <div class="filesv2-browser__drop" aria-hidden="true">
              <i class="ti ti-upload" />
              {b().dropHere}
            </div>
          </Show>
          <header class="filesv2-browser__header">
            <div class="flex items-center gap-2">
              <input
                ref={filePicker}
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
              <input
                ref={folderPicker}
                type="file"
                multiple
                class="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                {...{ webkitdirectory: "" }}
                onChange={(event) => {
                  startUpload(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
              <Dropdown.Root items={addItems()}>
                <Dropdown.Trigger iconOnly label={b().add} variant="input" disabled={busy() || searching()}>
                  <i class="ti ti-plus" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
              <TextInput
                type="search"
                icon="ti ti-search"
                placeholder={b().search}
                aria-label={b().searchIn(folder().split("/").at(-1) || props.directory.base.name)}
                value={searchText()}
                onValueChange={setSearchText}
                onSubmit={submitSearch}
                clearable
                clearLabel={b().clearSearch}
                onClear={() => {
                  setSearchText("");
                  if (searching()) props.onSearch?.(null);
                }}
                class="filesv2-search"
              />
            </div>
            <div class="filesv2-toolbar">
              <Show
                when={selectedPaths().length}
                fallback={
                  <span class="text-xs text-dimmed">
                    {searching() ? b().searchResults(props.directory.items.length) : b().pageItems(props.directory.items.length)}
                  </span>
                }
              >
                <span class="text-xs font-medium" role="status">
                  {b().selectedActions(selectedPaths().length)}
                </span>
                <Dropdown.Root items={selectionItems()}>
                  <Dropdown.Trigger size="sm" variant="secondary" disabled={busy()}>
                    {b().actions}
                    <i class="ti ti-chevron-down" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <span class="flex-1" />
              <span class="flex shrink-0 items-center gap-1">
                <Show when={view().view === "grid"}>
                  <SegmentedControl
                    label={b().viewSize}
                    size="sm"
                    value={view().size}
                    options={[
                      { value: "sm", label: "S" },
                      { value: "md", label: "M" },
                      { value: "lg", label: "L" },
                    ]}
                    onValueChange={(value) => updateView({ size: value })}
                  />
                </Show>
                <SegmentedControl
                  label={b().view}
                  size="sm"
                  value={view().view}
                  disabled={searching()}
                  options={[
                    { value: "list", label: b().list, icon: "ti ti-list" },
                    { value: "grid", label: b().grid, icon: "ti ti-layout-grid" },
                    { value: "tree", label: b().tree, icon: "ti ti-list-tree" },
                  ]}
                  onValueChange={(value) => updateView({ view: value })}
                />
              </span>
            </div>
            <For each={props.issues}>
              {(issue) => (
                <InlineGuidance tone="info">
                  <strong>{t()[issue.area]}: </strong>
                  <IssueMessage code={issue.code} />
                </InlineGuidance>
              )}
            </For>
            <Show when={props.error}>
              <InlineGuidance tone="danger" role="alert">
                {props.error}{" "}
                <Button size="xs" variant="text" onClick={props.onRetry}>
                  {b().retry}
                </Button>
              </InlineGuidance>
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
            when={props.directory.items.length || (folder() && !searching())}
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
            <ContextMenu class="filesv2-browser__collection" tabIndex={-1} items={contextItems()} label={t().actions} disabled={busy()}>
              <ScrollArea class="h-full" scrollPreserveKey={`filesv2:${folderKey(baseId(), folder())}:${props.after ?? ""}:${view().view}`}>
                <Show
                  when={view().view === "grid"}
                  fallback={
                    <>
                      <FileList
                        baseId={baseId()}
                        rows={rows()}
                        selection={selection}
                        label={t().files}
                        tree={view().view === "tree"}
                        pathBase={searching() ? folder() : null}
                        showModified={!searching()}
                        opening={opening()}
                        onUp={
                          folder() && !searching() && view().view !== "tree"
                            ? () => {
                                setOpening("..");
                                selection.clear();
                                props.onOpenDirectory?.(parentPath(folder()));
                              }
                            : undefined
                        }
                        messages={{
                          name: t().name,
                          size: t().size,
                          modified: t().modified,
                          details: b().detailsFor,
                          toggle: b().toggleFolder,
                          more: b().more,
                          up: b().parentFolderUp,
                        }}
                        onOpen={open}
                        onToggle={toggleBranch}
                        onLoadMore={(row) => {
                          const path = row.path.replace(/ more$/, "");
                          void loadBranch(path, branch(path)?.next);
                        }}
                        onDetails={(row) => selection.select(row.path)}
                        onContextMenu={focusContext}
                        onRowClick={rowClick}
                      />
                      <Show when={!props.directory.items.length && view().view !== "tree"}>
                        <Placeholder class="mx-2" icon="ti ti-folder" title={b().emptyTitle} description={b().emptyDescription} />
                      </Show>
                    </>
                  }
                >
                  <FileGrid
                    rows={props.directory.items}
                    getRowId={(row) => row.path}
                    selection={selection}
                    label={t().files}
                    size={view().size}
                    onOpen={open}
                    onContextMenu={focusContext}
                    onRowClick={(row) => {
                      if (row.directory && !touch()) return;
                      if (row.directory) open(row);
                    }}
                    renderPreview={(row) =>
                      opening() === row.path ? (
                        <i class="ti ti-loader-2 animate-spin text-3xl text-dimmed" aria-hidden="true" />
                      ) : (
                        <FileThumbnail baseId={baseId()} entry={row} large />
                      )
                    }
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
                  />
                </Show>
              </ScrollArea>
            </ContextMenu>
          </Show>
          <nav class="filesv2-browser__pagination" aria-label={t().files}>
            <Show when={props.after}>
              <ButtonLink
                href={filesUrl(baseId(), folder(), null, null, props.directory.query)}
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
                  href={filesUrl(baseId(), folder(), next(), null, props.directory.query)}
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
      <AppWorkspace.Detail id="filesv2-inspector" open={detailOpen()} width="md">
        <Show when={detailOpen()}>
          <FileInspector
            base={props.directory.base}
            cloudUrl={props.cloudUrl}
            paths={selectedPaths()}
            selected={selected()}
            initial={props.detail}
            busy={busy()}
            onClose={() => {
              const focused = selection.focused();
              selection.clear();
              if (focused) selection.focus(focused);
            }}
            onOpen={open}
            onDownload={startDownload}
            onRename={(item) => void rename(item)}
            onDuplicate={duplicate}
            onMove={(item) => void moveOrCopy([item])}
            onCopy={(item) => void moveOrCopy([item], true)}
            onTrash={(item) => void trashItems([item])}
            onShare={props.onShare ? (item) => props.onShare?.([item.path]) : undefined}
            onShareInbox={props.onShareInbox ? (item) => props.onShareInbox?.(item.path) : undefined}
            onChanged={refresh}
          />
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
