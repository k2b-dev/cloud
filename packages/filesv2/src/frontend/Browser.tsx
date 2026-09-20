import { downloadArchive } from "@k2b/filegate/utils";
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
  Dropdown,
  FileGrid,
  FilterChip,
  InlineGuidance,
  Placeholder,
  prompts,
  ScrollArea,
  SegmentedControl,
  TextInput,
  type ToastHandle,
  toast,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type BaseSummary, type BasesResult, type BrowseOptions, type DirectoryResult, type EditorInfo, type EntryResult, ErrorSchema, type FileEntry,
} from "../contracts";
import { isMarkdown } from "../document-assets";
import { type DocumentKind, documentExtension, editableExtension } from "../documents";
import { useAssetMessages } from "./asset-messages";
import { useBrowserMessages } from "./browser-messages";
import { browseOptions, browseQuery, folderKey, parsePreferences, preferencesCookie, SORT_KEYS, type SortKey, type ViewPreference, viewFor, withView } from "./browser-preferences";
import { readDroppedEntries, uploadRelativePath } from "./dropped-files";
import FileInspector from "./FileInspector";
import FileList, { type FileRow, type RowAttributes, type VirtualRow } from "./FileList";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { IssueMessage } from "./feedback";
import { apiFailure, contentLease } from "./file-preview";
import { openDestinationDialog } from "./MoveDialog";
import { useFilesMessages } from "./messages";
import { openTemplatePicker } from "./Templates";
import { UploadConflict, uploadFile } from "./uploads";
import { filesUrl } from "./urls";

type Directory = DirectoryResult & { query?: string; scope?: "folder" | "tree" };
type Branch = { items: FileEntry[]; next: string | null; loading: boolean; error: boolean; pages?: number };
const nameValid = (value: string | undefined) => !!value && !value.includes("/") && value.trim() === value && value !== "." && value !== "..";
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};
const relativeName = uploadRelativePath;

export default function Browser(props: {
  directory: Directory;
  bases: readonly BaseSummary[];
  cloudUrl: string;
  after?: string;
  source?: string;
  detail?: EntryResult | null;
  preferences?: Record<string, ViewPreference>;
  pending?: boolean;
  preserveSelection?: boolean;
  error?: string;
  notice?: string;
  issues?: BasesResult["issues"];
  onSelectionSource?: (source: string) => void;
  onMarksChanged?: () => void;
  onBranchRefreshReady?: (refresh: ((signal: AbortSignal) => Promise<void>) | null) => void;
  onRetry?: () => void;
  onOpenDirectory?: (path: string) => void;
  onOpenTrash?: () => void;
  onSearch?: (query: string | null) => void;
  onBrowseChange?: (options: BrowseOptions) => void;
  onChanged?: (selectPath?: string | null) => void | Promise<void>;
  onShare?: (paths: readonly string[]) => void;
  onShareInbox?: (folder: string) => void;
  /** Collabora is configured: office files open in the editor and the plus menu offers new documents. */
  editor?: EditorInfo | null;
  onEdit?: (entry: FileEntry) => void;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const assets = useAssetMessages();
  const baseId = () => props.directory.base.id;
  const baseIdentity = () => JSON.stringify([baseId(), props.directory.base.locationKey]);
  const folder = () => props.directory.path;
  const searching = () => !!props.directory.query;
  // View settings belong to one storage base; a cookie remembers the latest bases.
  const [preferences, setPreferences] = createSignal(props.preferences ?? {});
  const activeBrowse = createMemo(() => browseOptions(new URL(props.source ?? "", "https://files.invalid").searchParams, viewFor(preferences(), baseId())));
  const [requestedBrowse, setRequestedBrowse] = createSignal<BrowseOptions | null>(null);
  const view = createMemo(() => {
    const browse = requestedBrowse() ?? activeBrowse();
    return { ...viewFor(preferences(), baseId()), ...browse, direction: browse.order, ...(searching() ? { view: "list" as const } : {}) };
  });
  createEffect(on(() => props.source, () => setRequestedBrowse(null), { defer: true }));
  createEffect(() => { if (props.error) setRequestedBrowse(null); });
  const updateView = (next: Partial<ViewPreference>) => {
    const updated = { ...view(), ...next };
    const value = withView(preferences(), baseId(), updated);
    setPreferences(value);
    cookies.writeJsonCookie(preferencesCookie, value);
    if (next.sort !== undefined || next.direction !== undefined || next.type !== undefined || next.groupFolders !== undefined) {
      const browse = { sort: updated.sort, order: updated.direction, type: updated.type, groupFolders: updated.groupFolders };
      setRequestedBrowse(browse);
      props.onBrowseChange?.(browse);
    }
  };
  const TYPE_FILTERS = ["all", "directories", "files"] as const;
  type TypeFilter = (typeof TYPE_FILTERS)[number];
  const typeFilter = () => view().type;
  // The server orders and filters the complete observation before paging. Never rearrange a page.
  const visibleItems = () => props.directory.items;
  const filtered = () => typeFilter() !== "all" && !visibleItems().length;
  const requestedFile = () => (props.source ? new URL(props.source, "https://files.invalid").searchParams.get("file") : null);
  const [externalPath, setExternalPath] = createSignal(requestedFile());
  // Checkboxes appear only while selecting; a plain click then toggles instead of opening.
  const [selecting, setSelecting] = createSignal(false);
  // The folder being opened shows a spinner in place of its icon; nothing else moves.
  const [opening, setOpening] = createSignal<string | null>(null);
  let mounted = false;
  let syncing = false;
  const locationKey = () => JSON.stringify([baseIdentity(), folder(), props.after ?? "", props.directory.query ?? "", activeBrowse()]);
  let location = locationKey();
  let lastSource = props.source;

  /*
   * Tree view: the whole storage from its root. Loaded folder contents are cached per base, the set of
   * expanded folders is the user's, and the current folder (the URL) is highlighted. Clicking a folder
   * name makes it current; clicking its icon only expands or collapses it.
   */
  const [branches, setBranches] = createSignal<Record<string, Branch>>({});
  const [expandedFolders, setExpandedFolders] = createSignal<ReadonlySet<string>>(new Set<string>());
  const branchKey = (path: string, base = baseIdentity()) => JSON.stringify([base, path]);
  const branch = (path: string) => branches()[branchKey(path)];
  const setBranch = (path: string, value: Branch, base = baseIdentity()) => setBranches((current) => ({ ...current, [branchKey(path, base)]: value }));
  const branchRequests = new Map<string, AbortController>();
  onCleanup(() => { for (const request of branchRequests.values()) request.abort(); });
  const loadBranch = async (path: string, after?: string | null, background?: AbortSignal) => {
    const base = baseId();
    const location = baseIdentity();
    const query = browseQuery(activeBrowse());
    const queryKey = JSON.stringify(query);
    const key = branchKey(path, location);
    if (background && branchRequests.has(key)) return;
    branchRequests.get(key)?.abort();
    const request = new AbortController();
    branchRequests.set(key, request);
    const previous = branch(path);
    const signal = background ? AbortSignal.any([background, request.signal]) : request.signal;
    if (!background) setBranch(path, { items: previous?.items ?? [], next: previous?.next ?? null, loading: true, error: false, pages: previous?.pages });
    try {
      const items = after ? [...(previous?.items ?? [])] : [];
      let next = after ?? undefined;
      const pageCount = background ? previous?.pages ?? 1 : 1;
      let pages = after ? previous?.pages ?? 1 : 0;
      for (let index = 0; index < pageCount; index++) {
        signal.throwIfAborted();
        const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId: base }, query: { path, after: next, ...query } }, { init: { signal } });
        if (!response.ok) {
          const error = ErrorSchema.safeParse(await response.clone().json());
          if (next && error.success && error.data.code === "cursor_invalid" && !signal.aborted) {
            branchRequests.delete(key);
            setBranch(path, { items: [], next: null, loading: false, error: false });
            toast(b().cursorReset);
            await loadBranch(path, undefined, background);
            return;
          }
          if (!signal.aborted && baseIdentity() === location && JSON.stringify(browseQuery(activeBrowse())) === queryKey) setBranch(path, { items: Number(response.status) === 403 || Number(response.status) === 404 ? [] : previous?.items ?? [], next: null, loading: false, error: true });
          return;
        }
        const page = await response.json();
        if (signal.aborted || baseIdentity() !== location || JSON.stringify(browseQuery(activeBrowse())) !== queryKey) return;
        items.push(...page.items);
        pages++;
        next = page.next ?? undefined;
        if (!next) break;
      }
      setBranch(path, { items, next: next ?? null, loading: false, error: false, pages });
    } catch {
      if (signal.aborted || baseIdentity() !== location || JSON.stringify(browseQuery(activeBrowse())) !== queryKey) return;
      setBranch(path, { items: previous?.items ?? [], next: previous?.next ?? null, loading: false, error: true, pages: previous?.pages });
    } finally {
      if (branchRequests.get(key) === request) branchRequests.delete(key);
    }
  };
  const refreshVisibleBranches = async (signal: AbortSignal) => {
    if (view().view !== "tree" || searching()) return;
    const identity = baseIdentity();
    const current = folder();
    // Only open ancestors make a branch visible. Already loaded pages bound the work; no subtree scan.
    for (const path of [...expandedFolders()]) {
      if (signal.aborted || baseIdentity() !== identity || view().view !== "tree") return;
      if (path === current || !branch(path) || !expandedFolders().has(path)) continue;
      if (ancestors(path).slice(0, -1).some(parent => !expandedFolders().has(parent))) continue;
      await loadBranch(path, undefined, signal);
    }
  };
  onMount(() => props.onBranchRefreshReady?.(refreshVisibleBranches));
  onCleanup(() => props.onBranchRefreshReady?.(null));

  const expandFolder = (path: string, expanded: boolean) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
    if (expanded && !branch(path)) void loadBranch(path);
  };
  const toggleBranch = (row: FileRow) => expandFolder(row.path, !expandedFolders().has(row.path));
  let treeContext = "";
  let treeBase = baseIdentity();
  let invalidateBranches = false;
  createEffect(on(
    () => [props.directory, view().view, searching(), baseIdentity(), JSON.stringify(browseQuery(activeBrowse()))] as const,
    ([directory, mode, search, identity, query]) => {
      // One owner resets and seeds the tree. Separate reset/populate effects can
      // erase a newly seeded branch and abort its replacement request.
      const context = JSON.stringify([identity, query]);
      if (context !== treeContext || invalidateBranches) {
        for (const request of branchRequests.values()) request.abort();
        branchRequests.clear();
        setBranches({});
        if (identity !== treeBase) setExpandedFolders(new Set<string>());
        treeBase = identity;
        treeContext = context;
        invalidateBranches = false;
      }
      if (mode !== "tree" || search) return;
      const current = directory.path;
      // The authoritative navigation snapshot supersedes an in-flight branch read.
      const key = branchKey(current);
      branchRequests.get(key)?.abort();
      branchRequests.delete(key);
      setBranch(current, { items: directory.items, next: directory.next, loading: false, error: false });
      setExpandedFolders(set => new Set<string>([...set, ...ancestors(current), current]));
      for (const path of new Set(["", ...ancestors(current), ...expandedFolders()])) {
        if (path !== current && !branch(path)) void loadBranch(path);
      }
    },
  ));
  // Rows keep their identity across recomputes so open thumbnails are not re-requested on every expand.
  let previousRows = new Map<string, FileRow>();
  const rows = createMemo<FileRow[]>(() => {
    if (view().view !== "tree" || searching()) return visibleItems();
    const out: FileRow[] = [];
    const reuse = new Map<string, FileRow>();
    const push = (row: FileRow) => {
      const known = previousRows.get(row.path);
      const same =
        known &&
        known.name === row.name &&
        known.size === row.size &&
        known.modified === row.modified &&
        known.directory === row.directory &&
        known.depth === row.depth &&
        known.expanded === row.expanded &&
        known.loading === row.loading &&
        known.more === row.more &&
        known.actions?.write === row.actions?.write && known.actions?.move === row.actions?.move && known.actions?.share === row.actions?.share;
      const value = same ? known : row;
      reuse.set(row.path, value);
      out.push(value);
    };
    const walk = (items: readonly FileEntry[], depth: number) => {
      for (const item of items) {
        const open = item.directory && expandedFolders().has(item.path) ? branch(item.path) : undefined;
        push({ ...item, depth, expanded: !!open, loading: open?.loading });
        if (open) {
          walk(open.items, depth + 1);
          if (open.next) push({ ...item, path: `${item.path} more`, name: "", more: true, depth: depth + 1 });
        }
      }
    };
    // A failed root listing still shows the current folder instead of nothing.
    const root = folder() ? branch("") : undefined;
    walk(folder() ? (root?.error ? props.directory.items : (root?.items ?? [])) : props.directory.items, 0);
    // A pending, filtered or paginated ancestor must not hide an already loaded
    // current folder. Until its tree path is available, show its direct contents.
    const rooted = !folder() || out.some(row => row.path === folder());
    if (!rooted) {
      out.length = 0;
      reuse.clear();
      walk(props.directory.items, 0);
    }
    if (rooted && root?.next && !root.error) push({ name: "", path: " more", directory: true, size: 0, modified: "", more: true, depth: 0 });
    previousRows = reuse;
    return out;
  });
  const entries = createMemo(() => rows().filter((row) => !row.more));
  const ids = () => [...new Set([...entries().map((row) => row.path), ...(externalPath() ? [externalPath()!] : [])])];
  const selection = createCollectionSelection({
    ids,
    initial: requestedFile() ? [requestedFile()!] : [],
    onChange: (paths) => {
      if (!mounted || syncing || location !== locationKey()) return;
      if (externalPath() && !paths.includes(externalPath()!)) setExternalPath(null);
      const source = filesUrl(baseId(), folder(), props.after, paths.length === 1 ? paths[0] : null, props.directory.query, props.directory.scope, activeBrowse());
      commitHistory(source, { replace: true, scroll: "manual", viewTransition: false });
      props.onSelectionSource?.(source);
    },
  });
  onCleanup(() => { mounted = false; });
  onMount(() => {
    mounted = true;
    // The SSR seed may be older than a view change made before visiting trash or shares.
    setPreferences(parsePreferences(document.cookie));
  });
  createEffect(() => {
    const next = locationKey();
    const source = props.source;
    if (next !== location || source !== lastSource) {
      syncing = true;
      setExternalPath(requestedFile());
      if (!props.preserveSelection || next !== location) selection.replace(requestedFile() ? [requestedFile()!] : []);
      syncing = false;
      if (next !== location) {
        setOpening(null);
        setSelecting(false);
      }
      location = next;
      lastSource = source;
    }
  });
  createEffect(() => {
    if (!props.pending && props.error) setOpening(null);
  });
  const canCreate = () => props.directory.actions?.create !== false;
  const movable = (items: readonly FileEntry[]) => items.every(item => item.actions?.move !== false);
  const shareable = (items: readonly FileEntry[]) => items.every(item => item.actions?.share !== false);
  const selectedPaths = createMemo(() => [...selection.selected()]);
  const selected = createMemo(() => entries().filter((row) => selection.selected().has(row.path)));
  let actionLocation: string | null = null;
  const busy = () => !!props.pending || download.loading() || upload.loading() || action.loading();
  const refresh = async (selectPath?: string | null) => {
    if (!mounted || (actionLocation && actionLocation !== locationKey())) return;
    invalidateBranches = true;
    await props.onChanged?.(selectPath);
  };
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
      const response = await apiClient.bases[":baseId"].archive.$post({ param: { baseId: baseId() }, json: { paths: normalizedPaths(items.map((item) => item.path)) } }, { init: { signal: abortSignal } });
      if (!response.ok) return apiFailure(response, t().downloadFailed);
      downloadArchive(await response.json());
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => download.abort());
  const startDownload = (items: readonly FileEntry[]) => {
    if (items.length && !busy()) void download.mutate(items);
  };

  /*
   * Uploads: Cloud opens a Filegate session per file; folders are recreated from relative paths first.
   * Progress lives in one toast. Name conflicts are answered once per batch: known ones up front
   * from the current listing, later ones with the same answer.
   */
  const upload = mutation.create({
    onError: (error) => toast.error(error.message),
    mutation: async ({ files, directories = [] }: { files: readonly File[]; directories?: readonly string[] }, { abortSignal }) => {
      const base = baseId();
      const root = folder();
      const uploadLocation = locationKey();
      const known = new Set(props.directory.items.filter((item) => !item.directory).map((item) => item.name));
      const conflicts = files.filter((file) => !relativeName(file).includes("/") && known.has(file.name)).length;
      let policy: "ask" | "overwrite" | "skip" = "ask";
      const decide = async (name: string, count: number) => {
        const choice = await prompts.confirm(count > 1 ? b().replaceManyQuestion({ count, total: files.length }) : b().replaceQuestion(name), {
          title: count > 1 ? b().replaceManyTitle : b().replaceTitle,
          confirmText: b().replaceAll,
          cancelText: files.length > count ? b().onlyNew(files.length - count) : b().skip,
          variant: "danger",
        });
        abortSignal.throwIfAborted();
        return choice === undefined ? null : choice ? ("overwrite" as const) : ("skip" as const);
      };
      if (conflicts) {
        const decided = await decide(files.find((file) => known.has(file.name))?.name ?? "", conflicts);
        if (!decided) return;
        policy = decided;
      }
      const folders = new Set<string>(directories);
      for (const file of files) {
        const parts = relativeName(file).split("/").slice(0, -1);
        for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      }
      const handle: ToastHandle = toast(b().uploadingTitle, { title: b().upload, progress: "indeterminate", duration: 0, action: { label: b().cancel, onClick: () => upload.abort() } });
      let createdFolders = 0;
      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let last: string | null = null;
      try {
        for (const path of [...folders].sort()) {
          const response = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: base }, json: { path: root ? `${root}/${path}` : path } }, { init: { signal: abortSignal } });
          if (!response.ok && (response.status as number) !== 409) await apiFailure(response, t().unavailable);
          if (response.ok) createdFolders++;
        }
        for (let index = 0; index < files.length; index++) {
          const file = files[index]!;
          const path = root ? `${root}/${relativeName(file)}` : relativeName(file);
          const report = (bytes: number) =>
            handle.update(b().uploading({ done: index, total: files.length, name: file.name, percent: file.size ? Math.floor((bytes / file.size) * 100) : 100 }), {
              progress: (index + (file.size ? bytes / file.size : 1)) / files.length,
            });
          report(0);
          let onConflict: "error" | "overwrite" = policy === "overwrite" ? "overwrite" : "error";
          for (;;) {
            try {
              const result = await uploadFile(base, path, file, { onConflict, signal: abortSignal, fallback: b().uploadFailed(file.name), onProgress: report });
              uploaded++;
              last = result.entry.path;
              break;
            } catch (error) {
              if (error instanceof UploadConflict && onConflict === "error") {
                if (policy === "ask") {
                  const decided = await decide(error.fileName, 1);
                  if (!decided) throw new DOMException("cancelled", "AbortError");
                  policy = decided;
                }
                if (policy === "overwrite") {
                  onConflict = "overwrite";
                  continue;
                }
                skipped++;
                break;
              }
              if (abortSignal.aborted) throw error;
              failed++;
              toast.error(error instanceof Error && error.message !== "path_conflict" ? error.message : b().uploadFailed(file.name));
              break;
            }
          }
        }
        handle.update(b().uploadSummary({ uploaded, skipped, failed }), { variant: failed ? "error" : "success", progress: null, duration: 5000, action: null });
      } catch (error) {
        handle.update(uploaded ? b().uploadSummary({ uploaded, skipped, failed }) : abortSignal.aborted ? b().uploadCancelled : b().uploadFailed(files[0]?.name ?? ""), {
          progress: null,
          duration: 4000,
          action: null,
          variant: abortSignal.aborted ? undefined : "error",
        });
        if (!abortSignal.aborted) throw error;
      } finally {
        if ((uploaded || createdFolders) && uploadLocation === locationKey()) void refresh(last);
      }
    },
  });
  onCleanup(() => upload.abort());
  const startUpload = (files: readonly File[], directories: readonly string[] = []) => {
    if (!files.length && !directories.length) return;
    if (busy() || searching() || !canCreate()) {
      toast(b().uploadUnavailable);
      return;
    }
    void upload.mutate({ files, directories });
  };
  let filePicker: HTMLInputElement | undefined;
  let folderPicker: HTMLInputElement | undefined;
  const drop = dropzone.create({});
  let dropPreparation: AbortController | undefined;
  onCleanup(() => dropPreparation?.abort());
  const onExternalDrop: typeof drop.handlers.onDrop = (event) => {
    drop.handlers.onDrop(event);
    if (!event.dataTransfer || busy() || searching() || !canCreate()) return;
    const entries = Array.from(event.dataTransfer.items ?? []).map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
    if (!entries.some(entry => entry.isDirectory)) { startUpload(Array.from(event.dataTransfer.files)); return; }
    dropPreparation?.abort();
    const request = new AbortController();
    dropPreparation = request;
    const source = locationKey();
    const timer = setTimeout(() => request.abort(), 30_000);
    const notice = toast(b().readingDrop, { duration: 0, progress: "indeterminate", action: { label: b().cancel, onClick: () => request.abort() } });
    void readDroppedEntries(entries, request.signal).then(result => {
      if (request.signal.aborted || source !== locationKey()) return;
      if (result.errors.length) toast.error(result.errors.join("\n"));
      startUpload(result.files, result.directories);
    }).catch(error => {
      if (!request.signal.aborted) toast.error(error instanceof Error && error.message === "drop_too_large" ? b().dropTooLarge : b().loadFailed);
    }).finally(() => { clearTimeout(timer); notice.dismiss(); });
  };

  // Mutations on the selection run through one loading state and one error surface.
  const action = mutation.create({
    mutation: async (run: () => Promise<void>) => {
      actionLocation = locationKey();
      try { await run(); } finally { actionLocation = null; }
    },
    onError: (error) => toast.error(error.message),
  });
  const runAction = (run: () => Promise<void>) => {
    if (!busy()) void action.mutate(run);
  };
  // Every name prompt says where the entry will live, which matters most in tree view.
  const askName = (title: string, label: string, initial = "") => {
    const source = locationKey();
    return prompts
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
          name: { type: "text", label, required: true, maxLength: 255, default: initial, validate: (value) => (nameValid(value) ? null : b().newFolderInvalid) },
        },
      })
      .then((values) => (values && source === locationKey() ? String(values.name) : null));
  };
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
  const editable = (entry: FileEntry) => !!props.onEdit && !entry.directory && (isMarkdown(entry.name) || (!!props.editor && !!editableExtension(entry.name)));
  const createMarkdown = async () => {
    const name = await askName(assets().markdown, assets().filename, assets().defaultMarkdown);
    if (!name) return;
    runAction(async () => {
      const path = [folder(), isMarkdown(name) ? name : `${name}.md`].filter(Boolean).join("/");
      const response = await apiClient.bases[":baseId"].markdown.$post({ param: { baseId: baseId() }, json: { path } });
      if (!response.ok) await apiFailure(response, assets().failed);
      const created = await response.json();
      if (mounted && actionLocation === locationKey()) props.onEdit?.(created.entry);
    });
  };
  const createFromTemplate = async () => {
    const source = locationKey();
    const template = await openTemplatePicker();
    if (!template || source !== locationKey()) return;
    const name = await askName(assets().template, assets().filename, template.filename);
    if (!name || source !== locationKey()) return;
    runAction(async () => {
      const response = await apiClient.templates[":id"].use.$post({
        param: { id: template.id },
        json: { baseId: baseId(), path: [folder(), name].filter(Boolean).join("/") },
      });
      if (!response.ok) await apiFailure(response, assets().failed);
      const created = await response.json();
      if (!mounted || actionLocation !== locationKey()) return;
      if (editable(created.entry)) props.onEdit?.(created.entry);
      else await refresh(created.entry.path);
    });
  };
  const createDocument = async (kind: DocumentKind, title: string) => {
    const extension = documentExtension(kind, props.editor?.documentFormat ?? "odf");
    const name = await askName(title, b().documentName(extension));
    if (!name) return;
    const path = folder() ? `${folder()}/${name}` : name;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].documents.$post({ param: { baseId: baseId() }, json: { path, kind } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const created = await response.json();
      toast.success(b().documentCreated(created.entry.name));
      if (mounted && actionLocation === locationKey()) props.onEdit?.(created.entry);
    });
  };
  type BatchItem = { path: string; ok: boolean; error?: string };
  const normalizedPaths = (paths: readonly string[]) => [...new Set(paths)].filter(path => !paths.some(parent => parent !== path && path.startsWith(`${parent}/`)));
  const runBatches = async (paths: readonly string[], send: (batch: string[]) => Promise<BatchItem[]>) => {
    const results: BatchItem[] = [];
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      try { results.push(...await send(batch)); }
      catch (error) { results.push(...batch.map(path => ({ path, ok: false, error: error instanceof Error ? error.message : t().unavailable }))); }
    }
    return results;
  };
  const finishBatch = async (results: readonly BatchItem[], message: (count: number) => string, selectPath: string | null = null) => {
    const failures = results.filter(result => !result.ok);
    const succeeded = results.length - failures.length;
    if (succeeded) toast.success(message(succeeded));
    if (failures.length) toast.error(failures.map(result => `${result.path}: ${result.error ?? t().unavailable}`).join("\n"));
    await refresh(failures[0]?.path ?? selectPath);
    if (mounted && failures.length && actionLocation === locationKey()) { setSelecting(true); selection.replace(failures.map(result => result.path)); }
  };
  const moveIntoNewFolder = async (items: readonly FileEntry[]) => {
    const name = await askName(b().moveToNewFolder, b().newFolderName);
    if (!name) return;
    const path = folder() ? `${folder()}/${name}` : name;
    runAction(async () => {
      const made = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: baseId() }, json: { path } });
      if (!made.ok) await apiFailure(made, t().unavailable);
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map(item => item.path)), async paths => {
        const moved = await apiClient.bases[":baseId"].move.$post({ param: { baseId: base }, json: { paths, folder: path } });
        if (!moved.ok) await apiFailure(moved, t().unavailable);
        return (await moved.json()).results;
      });
      await finishBatch(results, b().moved, path);
    });
  };
  const moveOrCopy = async (items: readonly FileEntry[], copyOnly = false) => {
    const source = locationKey();
    const destination = await openDestinationDialog({ bases: props.bases, sourceBaseId: baseId(), sourcePaths: items.map((item) => item.path), initialFolder: folder(), copyOnly });
    if (!destination || source !== locationKey()) return;
    runAction(async () => {
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map(item => item.path)), async paths => {
        const response = destination.copy
          ? await apiClient.bases[":baseId"].copy.$post({ param: { baseId: base }, json: { paths, targetBaseId: destination.baseId, folder: destination.folder } })
          : await apiClient.bases[":baseId"].move.$post({ param: { baseId: base }, json: { paths, folder: destination.folder } });
        if (!response.ok) await apiFailure(response, t().unavailable);
        return (await response.json()).results;
      });
      await finishBatch(results, destination.copy ? b().copied : b().moved);
    });
  };
  const trashItems = async (items: readonly FileEntry[]) => {
    const source = locationKey();
    const confirmed = await prompts.confirm(b().moveTrashQuestion({ n: items.length, name: items[0]?.name ?? "" }), {
      title: b().moveTrashTitle,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: b().trashSelection,
    });
    if (!confirmed || source !== locationKey()) return;
    runAction(async () => {
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map(item => item.path)), async paths => {
        const response = await apiClient.bases[":baseId"].delete.$post({ param: { baseId: base }, json: { paths } });
        if (!response.ok) await apiFailure(response, t().unavailable);
        return (await response.json()).results;
      });
      await finishBatch(results, b().trashed);
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
      const response = await apiClient.bases[":baseId"].copy.$post({ param: { baseId: baseId() }, json: { paths: [item.path], targetBaseId: baseId(), folder: parentPath(item.path) } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      await finishBatch(result.results, () => b().duplicated, result.entries[0]?.path ?? null);
    });

  /*
   * Drag-and-drop moves inside the base: dragging a highlighted or checked entry takes the whole
   * selection along. Folders and the ".." row accept drops; resting on a folder opens it (list, grid)
   * or expands it (tree). The drag state lives here so it survives the navigation a hover triggers.
   */
  const HOVER_OPEN_MS = 900;
  const DRAG_TYPE = "application/x-filesv2-entries";
  const [dragging, setDragging] = createSignal<readonly string[] | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let lastDragSeen = 0;
  let dragWatch: ReturnType<typeof setInterval> | undefined;
  const clearHover = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = undefined;
  };
  const endDrag = () => {
    setDragging(null);
    setDropTarget(null);
    clearHover();
    if (dragWatch) clearInterval(dragWatch);
    dragWatch = undefined;
  };
  onMount(() => {
    // A drag source that navigated away never fires dragend; the window stops seeing dragover instead.
    const seen = () => {
      lastDragSeen = Date.now();
    };
    window.addEventListener("dragover", seen);
    window.addEventListener("drop", endDrag);
    onCleanup(() => {
      window.removeEventListener("dragover", seen);
      window.removeEventListener("drop", endDrag);
      endDrag();
    });
  });
  const beginDrag = (paths: readonly string[]) => {
    setDragging(paths);
    lastDragSeen = Date.now();
    dragWatch = setInterval(() => {
      if (Date.now() - lastDragSeen > 400) endDrag();
    }, 200);
  };
  const draggedPaths = (row: FileEntry) => (selection.selected().has(row.path) ? selectedPaths() : [row.path]);
  const dragImage = (paths: readonly string[], name: string) => {
    const element = document.createElement("div");
    element.className = "filesv2-drag-image";
    element.textContent = paths.length > 1 ? b().dragCount(paths.length) : name;
    document.body.append(element);
    return element;
  };
  const dragProps = (row: FileEntry): RowAttributes =>
    searching() || virtualOf(row) || row.actions?.move === false
      ? {}
      : {
          draggable: true,
          onDragStart: (event) => {
            const paths = draggedPaths(row);
            event.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ baseId: baseId(), paths }));
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              const image = dragImage(paths, row.name);
              event.dataTransfer.setDragImage(image, 12, 12);
              setTimeout(() => image.remove(), 0);
            }
            beginDrag(paths);
          },
          onDragEnd: endDrag,
          "data-dragging": dragging()?.includes(row.path) ? "true" : undefined,
        };
  const canDrop = (target: string) => {
    const paths = dragging();
    return !!paths && !paths.includes(target) && !paths.some((path) => target.startsWith(`${path}/`)) && !paths.every((path) => parentPath(path) === target);
  };
  const dropProps = (target: string, hover?: () => void): RowAttributes => ({
    onDragOver: (event) => {
      if (!canDrop(target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (dropTarget() !== target) {
        setDropTarget(target);
        clearHover();
        if (hover) hoverTimer = setTimeout(hover, HOVER_OPEN_MS);
      }
    },
    onDragLeave: (event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      if (dropTarget() === target) {
        setDropTarget(null);
        clearHover();
      }
    },
    onDrop: (event) => {
      if (!canDrop(target)) return;
      event.preventDefault();
      const paths = dragging()!;
      endDrag();
      void movePaths(paths, target);
    },
    "data-drop-target": dropTarget() === target && dragging() ? "true" : undefined,
  });
  const folderDrop = (row: FileEntry): RowAttributes =>
    row.directory && !searching() && !virtualOf(row) ? dropProps(row.path, () => (view().view === "tree" ? expandFolder(row.path, true) : openFolder(row.path))) : {};
  const upDrop = (): RowAttributes => (folder() ? dropProps(parentPath(folder()), goUp) : {});
  const movePaths = (paths: readonly string[], target: string) =>
    runAction(async () => {
      const base = baseId();
      const results = await runBatches(normalizedPaths(paths), async paths => {
        const response = await apiClient.bases[":baseId"].move.$post({ param: { baseId: base }, json: { paths, folder: target } });
        if (!response.ok) await apiFailure(response, t().unavailable);
        return (await response.json()).results;
      });
      await finishBatch(results, b().moved);
    });

  const open = (entry: FileEntry) => {
    if (busy()) return;
    if (entry.directory) {
      openFolder(entry.path);
      return;
    }
    if (editable(entry)) {
      props.onEdit?.(entry);
      return;
    }
    void prompts.dialog(() => <FilePreview baseId={baseId()} locationKey={props.directory.base.locationKey} entry={entry} onDownload={() => startDownload([entry])} />, { title: entry.name, size: "large" });
  };
  // Entering or leaving select mode starts clean; outside it a click only highlights one entry for its details.
  const toggleSelecting = (on: boolean) => {
    selection.clear();
    setSelecting(on);
  };
  const rowClick = (row: FileRow, event: MouseEvent) => {
    if (selecting()) {
      if (event.shiftKey) selection.select(row.path, event);
      else selection.toggle(row.path);
      return;
    }
    if (row.directory && !searching()) {
      if (view().view === "tree") {
        expandFolder(row.path, true);
        if (row.path !== folder()) openFolder(row.path);
      } else open(row);
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
      { label: items.length === 1 && !items[0]!.directory ? t().download : b().downloadZip, icon: "ti ti-download", action: () => startDownload(items) },
      ...(searching()
        ? []
        : [
            { disabled: !canCreate() || !movable(items), label: b().moveToNewFolder, icon: "ti ti-folder-plus", action: () => void moveIntoNewFolder(items) },
            { disabled: !movable(items), label: b().moveTo, icon: "ti ti-arrow-move-right", action: () => void moveOrCopy(items) },
            { label: b().copyTo, icon: "ti ti-copy", action: () => void moveOrCopy(items, true) },
          ]),
      ...(props.onShare && shareable(items) ? [{ label: b().shareSelection, icon: "ti ti-world-share", action: () => props.onShare?.(items.map((item) => item.path)) }] : []),
      { label: b().clear, icon: "ti ti-x", action: selection.clear },
      { items: [{ disabled: !movable(items), label: b().trashSelection, icon: "ti ti-trash", variant: "danger" as const, action: () => void trashItems(items) }] },
    ];
  };
  const contextItems = () => {
    const items = selected();
    if (!items.length) return addItems();
    if (items.length !== 1) return selectionItems();
    const item = items[0]!;
    return [
      { label: b().open, icon: item.directory ? "ti ti-folder-open" : "ti ti-eye", action: () => open(item) },
      { label: b().details, icon: "ti ti-info-circle", action: () => selection.select(item.path) },
      ...(searching() ? [] : [{ disabled: item.actions?.move === false, label: b().rename, icon: "ti ti-pencil", action: () => void rename(item) }, { disabled: !canCreate(), label: b().duplicate, icon: "ti ti-copy", action: () => duplicate(item) }]),
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
  const addItems = () => !canCreate() ? [] : [
    { label: b().upload, icon: "ti ti-upload", action: () => filePicker?.click() },
    { label: b().uploadFolder, icon: "ti ti-folder-up", action: () => folderPicker?.click() },
    { items: [{ label: b().newFolder, icon: "ti ti-folder-plus", action: () => void createFolder() }, { label: b().newFile, icon: "ti ti-file-plus", action: () => void createFile() },
            ],
          },
          { label: assets().markdown, icon: "ti ti-markdown", action: () => void createMarkdown() },
          { label: assets().template, icon: "ti ti-file-description", action: () => void createFromTemplate() },
    ...(props.editor && props.onEdit
      ? [
          {
            items: [
              { label: b().newDocument, icon: "ti ti-file-text", action: () => void createDocument("text", b().newDocument) },
              { label: b().newSpreadsheet, icon: "ti ti-table", action: () => void createDocument("spreadsheet", b().newSpreadsheet) },
              { label: b().newPresentation, icon: "ti ti-presentation", action: () => void createDocument("presentation", b().newPresentation) },
            ],
          },
        ]
      : []),
  ];
  const goUp = () => {
    setOpening("up");
    selection.clear();
    props.onOpenDirectory?.(parentPath(folder()));
  };
  const virtualBefore = (): VirtualRow[] => (folder() && !searching() && view().view !== "tree" ? [{ key: "up", label: "..", icon: "ti ti-folder-up", onClick: goUp }] : []);
  const virtualAfter = (): VirtualRow[] =>
    !folder() && !searching() && props.onOpenTrash ? [{ key: "trash", label: b().trashTitle, icon: "ti ti-trash", onClick: () => props.onOpenTrash?.() }] : [];
  // Virtual rows join the tile grid as entries with a reserved path; they are never selectable.
  const virtualKey = (row: VirtualRow) => `\u0000${row.key}`;
  const gridRows = createMemo<FileEntry[]>(() => [
    ...virtualBefore().map((row) => ({ name: row.label, path: virtualKey(row), directory: true, size: 0, modified: "" })),
    ...visibleItems(),
    ...virtualAfter().map((row) => ({ name: row.label, path: virtualKey(row), directory: true, size: 0, modified: "" })),
  ]);
  const virtualOf = (row: FileEntry) => [...virtualBefore(), ...virtualAfter()].find((item) => virtualKey(item) === row.path);
  const gridCheck = (row: FileEntry) => (
    <Show when={selecting()}>
      <span class="filesv2-grid-check">
        <Checkbox value={selection.selected().has(row.path)} label={<span class="sr-only">{b().selectEntry(row.name)}</span>} onValueChange={() => selection.toggle(row.path)} />
      </span>
    </Show>
  );
  // Tiles select on click through the grid itself; while selecting, that click toggles instead of replacing.
  // Ranges, toggles and select-all exist only with checkboxes; otherwise clicks and keys move the single highlight.
  const interactiveSelection = {
    ...selection,
    select: (id: string, modifiers?: Parameters<typeof selection.select>[1]) =>
      selecting() ? (modifiers?.shiftKey ? selection.select(id, modifiers) : selection.toggle(id)) : selection.select(id),
    keyDown: (event: KeyboardEvent, id: string, columns?: number) => {
      const multi = event.key === " " || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a");
      if (multi && !selecting()) return false;
      return selection.keyDown(event, id, columns);
    },
  };
  const sortLabel = (key: SortKey) => (key === "modified" ? b().sortModified : key === "size" ? b().sortSize : b().sortName);
  const filterLabel = (key: TypeFilter) =>
    key === "directories" ? b().filterFolders : key === "files" ? b().filterFiles : b().filterAll;
  const listMessages = () => ({ name: t().name, size: t().size, modified: t().modified, details: b().detailsFor, toggle: b().toggleFolder, select: b().selectEntry, more: b().more, up: b().parentFolderUp });
  return (
    <>
      <AppWorkspace.Main scroll={false} class="filesv2-browser" aria-busy={props.pending}>
        <div class="filesv2-browser__surface" data-dragging={drop.isDragging() && !dragging() && !searching() ? "true" : undefined} {...(dragging() ? {} : { ...drop.handlers, onDrop: onExternalDrop })}>
          <Show when={drop.isDragging() && !dragging() && !searching()}>
            <div class="filesv2-browser__drop" aria-hidden="true">
              <i class="ti ti-upload" />
              {b().dropHere}
            </div>
          </Show>
          <header class="filesv2-browser__header">
            <div class="flex items-center gap-2">
              <input ref={filePicker} type="file" multiple class="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { startUpload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
              <input ref={folderPicker} type="file" multiple class="sr-only" tabIndex={-1} aria-hidden="true" {...{ webkitdirectory: "" }} onChange={(event) => { startUpload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
              <Dropdown.Root items={addItems()}>
                <Dropdown.Trigger iconOnly label={b().add} variant="input" disabled={busy() || searching() || !canCreate()}>
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
              <FilterChip
                label={b().sortAndFilter}
                icon="ti ti-adjustments-horizontal"
                iconOnly
                variant="input"
                position="bottom-right"
                value={[view().sort, view().direction, typeFilter(), ...(view().groupFolders ? ["groupFolders"] : [])]}
                defaultValue={["name", "asc", "all", "groupFolders"]}
                isActive={view().sort !== "name" || view().direction !== "asc" || typeFilter() !== "all" || !view().groupFolders}
                onValueChange={(values) => {
                  updateView({
                    sort: SORT_KEYS.find((key) => values.includes(key)) ?? "name",
                    direction: values.includes("desc") ? "desc" : "asc",
                    groupFolders: values.includes("groupFolders"),
                    type: TYPE_FILTERS.find((key) => values.includes(key)) ?? "all",
                  });
                }}
                options={[
                  { label: b().sort, options: SORT_KEYS.map((key) => ({ value: key, label: sortLabel(key) })) },
                  {
                    label: b().sortDirection,
                    options: [
                      { value: "asc", label: b().sortAscending },
                      { value: "desc", label: b().sortDescending },
                    ],
                  },
                  { label: b().filter, options: TYPE_FILTERS.map((key) => ({ value: key, label: filterLabel(key) })) },
                  { multiple: true, options: [{ value: "groupFolders", label: b().groupFolders }] },
                ]}
              />
            </div>
            <Show when={props.notice}><InlineGuidance tone="info">{props.notice}</InlineGuidance></Show>
            <div class="filesv2-toolbar">
              <Show
                when={selecting()}
                fallback={
                  <span class="flex items-center gap-2 text-xs text-dimmed">
                    {searching() ? b().searchResults(props.directory.items.length) : b().pageItems(props.directory.items.length)}
                    <Show when={props.directory.items.length}>
                      <span aria-hidden="true">·</span>
                      <Button size="xs" variant="text" onClick={() => toggleSelecting(true)}>
                        {b().select}
                      </Button>
                    </Show>
                  </span>
                }
              >
                <span class="text-xs font-medium" role="status">
                  {b().selectedActions(selectedPaths().length)}
                </span>
                <Dropdown.Root items={selectionItems()}>
                  <Dropdown.Trigger size="sm" variant="secondary" disabled={busy() || !selectedPaths().length}>
                    {b().actions}
                    <i class="ti ti-chevron-down" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
                <Button size="xs" variant="text" onClick={() => toggleSelecting(false)}>
                  {b().endSelect}
                </Button>
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
          </header>
          <Show when={view().view === "tree" && !searching() && folder() && (!branch("") || branch("")?.loading || branch("")?.error)}>
            <InlineGuidance>
              {branch("")?.error ? b().treeLoadFailed : t().loadingFiles}
              <Show when={branch("")?.error}>
                <Button size="xs" variant="text" onClick={() => void loadBranch("")}>{b().retry}</Button>
              </Show>
            </InlineGuidance>
          </Show>
          <Show
            when={props.directory.items.length || (!searching() && (folder() || props.onOpenTrash))}
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
              <ScrollArea class="h-full" scrollPreserveKey={`filesv2:${folderKey(baseIdentity(), folder())}:${props.after ?? ""}:${view().view}`}>
                <Show
                  when={view().view === "grid"}
                  fallback={
                    <>
                      <FileList
                        baseId={baseId()}
                        rows={rows()}
                        selection={interactiveSelection}
                        label={t().files}
                        tree={view().view === "tree"}
                        pathBase={searching() ? folder() : null}
                        showModified={!searching()}
                        opening={opening()}
                        currentPath={view().view === "tree" ? folder() : null}
                        selecting={selecting()}
                        before={virtualBefore()}
                        after={virtualAfter()}
                        rowProps={(row) => ({ ...dragProps(row), ...folderDrop(row) })}
                        virtualProps={(row) => (row.key === "up" ? upDrop() : {})}

                        messages={listMessages()}
                        sort={{ key: view().sort, direction: view().direction }}
                        onSort={(key) => updateView(view().sort === key ? { direction: view().direction === "asc" ? "desc" : "asc" } : { sort: key, direction: "asc" })}
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
                      <Show when={!props.directory.items.length && !rows().length}>
                        <Placeholder class="mx-2" icon="ti ti-folder" title={b().emptyTitle} description={b().emptyDescription} />
                      </Show>
                      <Show when={filtered()}>
                        <Placeholder class="mx-2" icon="ti ti-filter-off" title={b().noMatches} />
                      </Show>
                    </>
                  }
                >
                  <div class="filesv2-grid-wrap">
                    <FileGrid
                      rows={gridRows()}
                      getRowId={(row) => row.path}
                      selection={interactiveSelection}
                      label={t().files}
                      size={view().size}
                      onOpen={(row) => (virtualOf(row) ? virtualOf(row)!.onClick() : open(row))}
                      itemProps={(row) => (virtualOf(row) ? (virtualOf(row)!.key === "up" ? upDrop() : {}) : { ...dragProps(row), ...folderDrop(row) })}
                      onContextMenu={(row) => !virtualOf(row) && focusContext(row)}
                      onRowClick={(row) => {
                        const virtual = virtualOf(row);
                        if (virtual) virtual.onClick();
                        else if (!selecting() && row.directory) open(row);
                      }}
                      renderPreview={(row) => {
                        const virtual = virtualOf(row);
                        if (virtual)
                          return (
                            <span class="filesv2-thumbnail filesv2-thumbnail--large filesv2-thumbnail--virtual">
                              <i class={opening() === virtual.key ? "ti ti-loader-2 animate-spin" : virtual.icon} aria-hidden="true" />
                            </span>
                          );
                        return (
                          <>
                            {gridCheck(row)}
                            {opening() === row.path ? <i class="ti ti-loader-2 animate-spin text-3xl text-dimmed" aria-hidden="true" /> : <FileThumbnail baseId={baseId()} locationKey={props.directory.base.locationKey} entry={row} large />}
                          </>
                        );
                      }}
                      renderLabel={(row) => <span title={virtualOf(row) ? undefined : row.name}>{row.name}</span>}
                      renderMeta={(row) => (searching() && !virtualOf(row) ? <span title={parentOf(row.path)}>{parentOf(row.path)}</span> : null)}
                    />
                    <Show when={!props.directory.items.length}>
                      <Placeholder class="mx-2" icon="ti ti-folder" title={b().emptyTitle} description={b().emptyDescription} />
                    </Show>
                    <Show when={filtered()}>
                      <Placeholder class="mx-2" icon="ti ti-filter-off" title={b().noMatches} />
                    </Show>
                  </div>
                </Show>
              </ScrollArea>
            </ContextMenu>
          </Show>
          <nav class="filesv2-browser__pagination" aria-label={t().files}>
            <Show when={props.after}>
              <ButtonLink href={filesUrl(baseId(), folder(), null, null, props.directory.query, props.directory.scope, activeBrowse())} navigation="enhanced" onNavigate={props.onNavigate} size="sm" variant="secondary">
                {t().first}
              </ButtonLink>
            </Show>
            <Show when={props.directory.next}>
              {(next) => (
                <ButtonLink href={filesUrl(baseId(), folder(), next(), null, props.directory.query, props.directory.scope, activeBrowse())} navigation="enhanced" onNavigate={props.onNavigate} size="sm" variant="secondary">
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
            paths={selectedPaths().length > 1 ? selected().map((row) => row.path) : selectedPaths()}
            selected={selected()}
            initial={props.detail}
            busy={busy()}
            onClose={() => {
              const focused = selection.focused();
              selection.clear();
              if (focused) selection.focus(focused);
            }}
            onOpen={open}
            editable={editable}
            canEdit={selected().length === 1 ? selected()[0]?.actions?.write : undefined}
            onDownload={startDownload}
            onRename={(item) => void rename(item)}
            onDuplicate={duplicate}
            onMove={(item) => void moveOrCopy([item])}
            onCopy={(item) => void moveOrCopy([item], true)}
            onTrash={(item) => void trashItems([item])}
            onShare={props.onShare ? (item) => props.onShare?.([item.path]) : undefined}
            onShareInbox={props.onShareInbox ? (item) => props.onShareInbox?.(item.path) : undefined}
            onChanged={refresh}
            onMarksChanged={props.onMarksChanged}

          />
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
