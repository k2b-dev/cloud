import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { cookies } from "@k2b/stdlib/browser";
import { formatFileViewSize, toast, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Empty,
  Failed,
  FilterBar,
  Icon,
  Inline,
  Input,
  List,
  ListOrder,
  Loading,
  Menu,
  type MenuEntry,
  Nav,
  type NavGroup,
  type NavItem,
  Notice,
  type OnNavigate,
  Pane,
  Path,
  Row,
  StatusRow,
  Table,
  Text,
  Tiles,
  type TwoActions,
  Workspace,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry } from "../contracts";
import { useAssetMessages } from "./asset-messages";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { preferencesCookie, type ViewPreference, viewFor, withView } from "./browser-preferences";
import { directoryContext, directoryPageCount, directoryPages } from "./directory-pages";
import EntryDetail from "./EntryDetail";
import { entryIcon } from "./entry-icon";
import { historyExecutionHref } from "./execution-url";
import { issueText } from "./feedback";
import { createFilesUploads } from "./files-uploads";
import { createFolderActions, type FolderOperation } from "./folder-actions";
import {
  browseOf,
  type FolderAddress,
  type FolderState,
  folderQueries,
  preferenceOf,
  readFolderAddress,
  type SearchListState,
  searchOf,
} from "./folder-query";
import type { HistoryTarget } from "./history-actions";
import { entryHref, recheckActivity, resolveTarget } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { placeDescriber } from "./history-requests";
import { useFilesMessages } from "./messages";
import { openShareDialog } from "./ShareDialog";
import { searchRequest } from "./search-state";
import { snapshotTitle } from "./trail";
import { activityUrl, editorUrl, filesUrl } from "./urls";
import { createWorkspaceState, type DirectoryView, type WorkspaceSnapshot } from "./workspace-state";

/** Listings are read again while the tab is visible; Filegate has no change feed yet. */
const LIVE_REFRESH_MS = 20_000;
const ORIGIN = "https://files.invalid";
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};
const paramsOf = (source: string) => new URL(source, ORIGIN).searchParams;
/** The list parameters a folder keeps while moving between folders: its order, grouping and what it shows. */
const KEPT = ["sort", "group", "type"] as const;
const FILTER_ICONS = { type: "files", kind: "file-search", size: "ruler-2", modified: "calendar", match: "equal" } as const;
const viewHref = (baseId: string | null, view: "trash" | "shares" | "favorites") =>
  `${filesUrl(baseId ?? undefined)}${baseId ? "&" : "?"}view=${view}`;

/** One line of the folder: an entry, or a file still being made at its place. */
type FolderRow = { key: string; entry: FileEntry; fresh: boolean };

/**
 * A folder of Files on UI v2: the storage places and the folders above in the sidebar, the path and the folder's deeds
 * in the head, the listing with its filters, sort and selection, and the open entry beside it. The address holds the
 * folder, its list query and the open entry; moving between folders happens in place, so uploads keep running.
 */
export default function FilesScreen(props: {
  initial: WorkspaceSnapshot;
  preferences?: Record<string, ViewPreference>;
  timeZone?: string;
}) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const h = useHistoryMessages();
  const assets = useAssetMessages();
  const locale = useLocale();
  const timeZone = () => props.timeZone ?? "UTC";
  const queries = createMemo(() => folderQueries(b()));
  // The view of each storage: the server's copy first, so the first picture matches; the cookie after every change.
  const [preferences, setPreferences] = createSignal(props.preferences ?? {});
  const preference = (baseId: string | null) => viewFor(preferences(), baseId ?? "");
  const apiError = async (response: { json: () => Promise<unknown> }) => {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    return new Error(parsed.success ? parsed.data.message : t().unavailable);
  };
  // A background read that found changes hands its directory to the next load once.
  let polled: { source: string; value: DirectoryView } | null = null;
  const workspace = createWorkspaceState<WorkspaceSnapshot>({
    initial: props.initial,
    load: async (source, signal) => {
      const fresh = polled;
      polled = null;
      const params = paramsOf(source);
      const basesResponse = await apiClient.bases.$get({}, { init: { signal } });
      if (!basesResponse.ok) throw await apiError(basesResponse);
      const bases = await basesResponse.json();
      const requested = params.get("base");
      const selected = requested
        ? bases.items.find((base) => base.id === requested)
        : (bases.items.find((base) => base.status === "existing") ?? bases.items[0]);
      if (requested && !selected) throw new Error(t().missingDescription);
      let directory: DirectoryView | null = null;
      if (selected?.status === "existing") {
        const address = readFolderAddress(queries(), params, preference(selected.id));
        const search = searchOf(address, params);
        const path = params.get("path") ?? "";
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(LIVE_REFRESH_MS)]);
        directory =
          fresh?.source === source && fresh.value.base.locationKey === selected.locationKey
            ? fresh.value
            : await directoryPages(
                directoryPageCount(params),
                params.get("after") ?? undefined,
                async (after) => {
                  const response = search
                    ? await apiClient.bases[":baseId"].search.$get(
                        { param: { baseId: selected.id }, query: { path, after, ...searchRequest(search) } },
                        { init: { signal: bounded } },
                      )
                    : await apiClient.bases[":baseId"].entries.$get(
                        {
                          param: { baseId: selected.id },
                          query: { path, after, ...browseQueryOf(address) },
                        },
                        { init: { signal: bounded } },
                      );
                  if (response.ok) return await response.json();
                  const error = ErrorSchema.safeParse(await response.json().catch(() => null));
                  const code = error.success ? error.data.code : "unavailable";
                  // A failed search stays a search, so its field and filters can narrow it.
                  if (search && code !== "cursor_invalid")
                    return {
                      base: selected,
                      path,
                      items: [],
                      next: null,
                      query: search.q,
                      scope: search.scope,
                      total: null,
                      failure: code,
                    };
                  // An old folder address: the server shows where it went, so the page loads from there.
                  if (Number(response.status) === 404 && !search && path && !params.get("after")) window.location.assign(source);
                  throw new Error(error.success ? error.data.message : t().unavailable);
                },
                bounded,
              );
      }
      return { source, bases, selectedId: selected?.id ?? null, directory, errorCode: null, now: new Date().toISOString() };
    },
  });
  const snapshot = workspace.snapshot;
  const params = createMemo(() => paramsOf(snapshot().source));
  const selected = () => snapshot().bases.items.find((base) => base.id === snapshot().selectedId);
  const directory = () => snapshot().directory;
  const folder = () => directory()?.path ?? params().get("path") ?? "";
  const address = createMemo((): FolderAddress => readFolderAddress(queries(), params(), preference(snapshot().selectedId)));
  const folderState = createMemo(() => {
    const current = address();
    return current.mode === "folder" ? current.state : undefined;
  });
  const searchListState = createMemo(() => {
    const current = address();
    return current.mode === "search" ? current.state : undefined;
  });
  const search = createMemo(() => searchOf(address(), params()));
  const searching = () => search() !== null;
  const openPath = () => params().get("file");
  const hasOverview = () => snapshot().bases.items.length > 1;
  const canCreate = () => directory()?.actions?.create !== false && selected()?.status === "existing";
  const label = (base: NonNullable<ReturnType<typeof selected>>) => baseLabel(base, b(), locale());
  const folderName = (path: string) => path.split("/").at(-1) || (selected() ? label(selected()!) : t().files);

  /** A folder of the open storage, keeping the list's order and grouping; `file` opens an entry beside it. */
  const folderHref = (path: string, file?: string | null) => {
    const next = new URLSearchParams(paramsOf(filesUrl(snapshot().selectedId ?? undefined, path, null, file)));
    for (const key of KEPT) {
      const value = params().get(key);
      if (value) next.set(key, value);
    }
    return `/app/filesv2${next.size ? `?${next}` : ""}`;
  };
  /** This folder or search with the open entry changed; the loaded pages stay. */
  const withFile = (file: string | null) => {
    const next = new URLSearchParams(params());
    next.delete("refreshed");
    if (file) next.set("file", file);
    else next.delete("file");
    return `/app/filesv2${next.size ? `?${next}` : ""}`;
  };
  /** The address of a list state: where it stands, then the query; a new state starts at the first page. */
  const stateHref = (write: (place: URLSearchParams) => URLSearchParams) => {
    const place = new URLSearchParams();
    for (const key of ["base", "path", "scope"]) {
      const value = params().get(key);
      if (value) place.set(key, value);
    }
    const next = write(place);
    return `/app/filesv2${next.size ? `?${next}` : ""}`;
  };
  const folderStateHref = (state: FolderState) => stateHref((place) => queries().folder.serialize(state, place));
  const searchStateHref = (state: SearchListState) => stateHref((place) => queries().search.serialize(state, place));

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────────────────────────
  const [cursorNotice, setCursorNotice] = createSignal(params().get("refreshed") === "true");
  const invalidCursor = (error: string | undefined) => !!error && /cursor/i.test(error);
  /** A Files address this screen shows in place: a folder or a search, never one of the other views. */
  const ownsAddress = (url: URL) => url.pathname === "/app/filesv2" && !url.searchParams.has("view");
  const go = async (target: string, replace = false) => {
    setCursorNotice(false);
    await workspace.navigate(target, () => commitHistory(target, { replace, scroll: "manual" }));
    if (invalidCursor(workspace.failure()?.message) && (params().has("after") || params().has("pages"))) {
      const first = new URL(target, ORIGIN);
      first.searchParams.delete("after");
      first.searchParams.delete("pages");
      setCursorNotice(true);
      await go(`${first.pathname}${first.search}`, true);
    }
  };
  const onNavigate: OnNavigate = (event: LinkNavigateEvent) => {
    if (!ownsAddress(event.url)) return event.fallback();
    const target = `${event.url.pathname}${event.url.search}`;
    setCursorNotice(false);
    void workspace.navigate(target, () => {
      if (target === `${window.location.pathname}${window.location.search}` || event.replace)
        event.replaceWith(target, { scroll: "manual" });
      else event.push(target, { scroll: "manual" });
    });
  };
  // A history step of the filter bar arrives here as well; the step itself loads the page.
  let stepping = false;
  onMount(() => {
    const mark = () => {
      stepping = true;
      // Microtasks run between the listeners of one event; the next task comes after all of them.
      setTimeout(() => {
        stepping = false;
      }, 0);
    };
    addEventListener("popstate", mark, { capture: true });
    onCleanup(() => removeEventListener("popstate", mark, { capture: true }));
    onCleanup(
      listenPopState(({ url }) => {
        if (!ownsAddress(url)) return window.location.reload();
        const target = `${url.pathname}${url.search}`;
        if (target === workspace.committedSource() && !workspace.pending()) return;
        void workspace.navigate(target);
      }),
    );
  });
  /** A new list state from the filter bar or the order: it wrote the address; the storage remembers its view. */
  const changeFolder = (state: FolderState) => {
    if (stepping) return;
    const base = snapshot().selectedId;
    if (base) {
      const next = withView(preferences(), base, preferenceOf(state, preference(base)));
      setPreferences(next);
      cookies.writeJsonCookie(preferencesCookie, next);
    }
    void go(folderStateHref(state), true);
  };
  const changeSearch = (state: SearchListState) => {
    if (stepping) return;
    // Without a search word the filters look below the folder in the folder's order.
    void go(
      state.search
        ? searchStateHref(state)
        : stateHref((place) => queries().folder.serialize({ ...queries().folder.reset(), filters: state.filters }, place)),
      true,
    );
  };
  const submitSearch = (text: string) => {
    const words = text.trim();
    const current = address();
    if (words === (current.state.search ?? "")) return;
    const filters = current.state.filters;
    if (words) {
      const next = queries().search.set({ ...queries().search.reset(), filters }, "q", words);
      if (next) void go(searchStateHref(next));
    } else void go(stateHref((place) => queries().folder.serialize({ ...queries().folder.reset(), filters }, place)));
  };

  // The way up: Alt+↑, the shell's way up and Backspace in the listing move in place like every other link here.
  const up = () => (folder() ? folderHref(parentPath(folder())) : hasOverview() ? filesUrl() : null);
  const goUp = () => {
    const target = up();
    if (!target) return;
    if (ownsAddress(new URL(target, ORIGIN))) void go(target);
    else window.location.assign(target);
  };
  createEffect(() => {
    if (!up()) return;
    onCleanup(
      registerContextAwareCommand({
        id: "filesv2.parent-folder",
        title: folder() ? b().parentRow : b().allStorage,
        description: folder() ? b().parentFolderUp(folderName(parentPath(folder()))) : b().allStorageUp,
        icon: folder() ? "ti ti-folder-up" : "ti ti-layout-grid",
        shortcut: "alt+arrowup",
        action: goUp,
      }),
    );
  });
  onMount(() => {
    onCleanup(
      layout.handleUp((href) => {
        const url = new URL(href, window.location.origin);
        if (!ownsAddress(url)) return false;
        void go(`${url.pathname}${url.search}`);
        return true;
      }),
    );
    const backspace = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-k2-part="Table"], [data-k2-part="Tiles"]')) return;
      if (event.target.closest("input,textarea,select,[contenteditable]")) return;
      event.preventDefault();
      goUp();
    };
    document.addEventListener("keydown", backspace);
    onCleanup(() => document.removeEventListener("keydown", backspace));
  });
  // The shell names the folder, or the search, and follows every navigation in place.
  createEffect(
    on(
      () => snapshotTitle(snapshot(), t().files, b(), locale()),
      (breadcrumbs, previous) => {
        if (previous && JSON.stringify(previous) === JSON.stringify(breadcrumbs)) return;
        layout.update({ breadcrumbs });
      },
      { defer: true },
    ),
  );

  // ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────
  const [chosen, setChosen] = createSignal<readonly string[]>([]);
  createEffect(
    on(
      () => directoryContext(snapshot().source),
      () => setChosen([]),
      { defer: true },
    ),
  );
  const entries = () => directory()?.items ?? [];
  const chosenEntries = createMemo(() => entries().filter((entry) => chosen().includes(entry.path)));

  // ── Deeds ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const uploads = createFilesUploads();
  const refresh = async (selectPath?: string | null) => {
    if (!directory()) return;
    await go(withFile(selectPath === undefined ? openPath() : selectPath), true);
  };
  const share = (paths: readonly string[]) =>
    void openShareDialog({
      baseId: snapshot().selectedId!,
      kind: "download",
      paths,
      defaultTitle: paths.length === 1 ? paths[0]!.split("/").at(-1)! : `${folderName(folder())} (${paths.length})`,
    });
  const shareInbox = (path: string) =>
    void openShareDialog({ baseId: snapshot().selectedId!, kind: "inbox", folder: path, defaultTitle: folderName(path) });
  // The editors are views of their own; they load as their page.
  const edit = (entry: FileEntry) => window.location.assign(editorUrl(snapshot().selectedId!, entry.path));
  const actions = createFolderActions({
    base: () => selected()!,
    bases: () => snapshot().bases.items,
    folder,
    entries,
    location: () => directoryContext(snapshot().source),
    searching,
    canCreate,
    editor: () => snapshot().bases.editor,
    uploads,
    refresh,
    onEdit: edit,
    onShare: share,
    select: setChosen,
  });
  // Leaving for another view of Files loads a page; while files upload, the browser asks first.
  onMount(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (uploads.batch.phase === "running") event.preventDefault();
    };
    addEventListener("beforeunload", guard);
    onCleanup(() => removeEventListener("beforeunload", guard));
  });

  // ── Live refresh ────────────────────────────────────────────────────────────────────────────────────────────────
  onMount(() => {
    let reading = false;
    const timer = setInterval(async () => {
      const shown = directory();
      if (reading || document.visibilityState !== "visible" || !navigator.onLine || workspace.pending() || !shown || searching()) return;
      reading = true;
      const request = new AbortController();
      const stop = setTimeout(() => request.abort(), LIVE_REFRESH_MS);
      const source = workspace.committedSource();
      try {
        const page = await directoryPages(
          shown.loadedPages ?? 1,
          params().get("after") ?? undefined,
          async (cursor) => {
            const response = await apiClient.bases[":baseId"].entries.$get(
              { param: { baseId: shown.base.id }, query: { path: shown.path, after: cursor, ...browseQueryOf(address()) } },
              { init: { signal: request.signal } },
            );
            if (!response.ok) throw await apiError(response);
            return await response.json();
          },
          request.signal,
        );
        if (request.signal.aborted || workspace.pending() || directory() !== shown) return;
        const unchanged =
          JSON.stringify(page.items) === JSON.stringify(shown.items) &&
          page.next === shown.next &&
          page.actions?.create === shown.actions?.create;
        if (unchanged) return;
        polled = { source, value: page };
        await workspace.navigate(source);
      } catch {
        // A failed background read leaves the folder as it is; the next visible read tries again.
      } finally {
        clearTimeout(stop);
        reading = false;
      }
    }, LIVE_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  // ── History in the detail ──────────────────────────────────────────────────────────────────────────────────────
  const history = createMemo(() => ({
    env: {
      now: snapshot().now ?? props.initial.now ?? new Date().toISOString(),
      timeZone: timeZone(),
      executionHref: historyExecutionHref,
      describePlace: placeDescriber(snapshot().bases.items, b(), locale()),
      onNavigate: (event: LinkNavigateEvent) => onNavigate(event),
    },
    initial: snapshot().history,
    actions: {
      onOpen: async (target: HistoryTarget) => {
        try {
          const resolved = await resolveTarget(target, h().actionFailed, workspace.navigationSignal());
          const href = entryHref(resolved);
          if (ownsAddress(new URL(href, ORIGIN))) await go(href);
          else window.location.assign(href);
        } catch (error) {
          toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
        }
      },
      onRecheck: async (entry: Parameters<typeof recheckActivity>[0]) => {
        await recheckActivity(entry, h().actionFailed);
      },
    },
    activityHref: (baseId: string, path: string, scope: "folder" | "item") =>
      activityUrl({ baseId, path, ...(scope === "folder" ? { scope } : {}) }),
  }));

  // ── Words and rows ──────────────────────────────────────────────────────────────────────────────────────────────
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const date = createMemo(() => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: timeZone() }));
  // A phone row has room for the day alone.
  const day = createMemo(() => new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeZone: timeZone() }));
  const sizeText = (entry: FileEntry) => (entry.directory ? "" : formatFileViewSize(entry.size, locale()));
  const fresh = () => actions.fresh();
  const rows = createMemo((): FolderRow[] => entries().map((entry) => ({ key: entry.path, entry, fresh: fresh().has(entry.path) })));
  const placeOf = (entry: FileEntry) => {
    const within = folder() ? entry.path.slice(folder().length + 1) : entry.path;
    return parentPath(within) || folderName(folder());
  };
  const openTarget = (entry: FileEntry) => ({
    href: entry.directory ? folderHref(entry.path) : withFile(entry.path),
    onNavigate,
  });
  const lead = () => {
    const shown = directory();
    if (!shown) return "";
    if (!searching()) return b().pageItems(shown.items.length);
    if (typeof shown.total !== "number") return b().searchResults(shown.items.length);
    return shown.truncated ? b().searchTruncated(shown.total) : b().searchTotal(shown.total);
  };
  const chosenBytes = () =>
    chosenEntries()
      .filter((entry) => !entry.directory)
      .reduce((sum, entry) => sum + entry.size, 0);
  const movable = (items: readonly FileEntry[]) => items.every((item) => item.actions?.move !== false);
  const shareable = (items: readonly FileEntry[]) => items.every((item) => item.actions?.share !== false);
  /** The deeds of one entry, behind its "…". */
  const entryMenu = (entry: FileEntry): MenuEntry[] => [
    entry.directory
      ? { label: b().open, icon: "folder-open", href: folderHref(entry.path), onNavigate }
      : actions.editable(entry)
        ? { label: entry.actions?.write === false ? b().openReadOnly : b().edit, icon: "pencil", onClick: () => edit(entry) }
        : { label: b().preview, icon: "eye", onClick: () => actions.preview(entry) },
    { label: b().details, icon: "info-circle", href: withFile(entry.path), onNavigate },
    {
      label: entry.directory ? b().downloadZip : t().download,
      icon: "download",
      disabled: actions.busy(),
      onClick: () => actions.startDownload([entry]),
    },
    ...(entry.actions?.share !== false ? [{ label: b().shareSelection, icon: "world-share", onClick: () => share([entry.path]) }] : []),
    ...(searching()
      ? []
      : [
          "separator" as const,
          { label: b().rename, icon: "pencil", disabled: entry.actions?.move === false, onClick: () => void actions.rename(entry) },
          { label: b().duplicate, icon: "copy", disabled: !canCreate(), onClick: () => actions.duplicate(entry) },
          {
            label: b().moveTo,
            icon: "arrow-move-right",
            disabled: entry.actions?.move === false,
            onClick: () => void actions.moveOrCopy([entry]),
          },
          { label: b().copyTo, icon: "folder-symlink", onClick: () => void actions.moveOrCopy([entry], true) },
        ]),
    {
      label: b().trashSelection,
      icon: "trash",
      danger: true,
      disabled: entry.actions?.move === false,
      onClick: () => void actions.trashItems([entry]),
    },
  ];
  /** What can be done with the chosen entries, at the place of the status row while they are chosen. */
  const selectionActions = () => {
    const items = chosenEntries();
    const pdfs = items.length > 0 && items.every(actions.isPdf) && !searching() && canCreate();
    return [
      ...(pdfs && items.length > 1 ? [{ label: b().pdfMerge, icon: "stack-2", onClick: () => void actions.mergePdfs(items) }] : []),
      ...(pdfs ? [{ label: b().pdfExtract, icon: "files", onClick: () => void actions.extractPages(items) }] : []),
      {
        label: items.length === 1 && !items[0]!.directory ? t().download : b().downloadZip,
        icon: "download",
        disabled: actions.busy(),
        onClick: () => actions.startDownload(items),
      },
      ...(shareable(items)
        ? [{ label: b().shareSelection, icon: "world-share", onClick: () => share(items.map((item) => item.path)) }]
        : []),
      ...(searching()
        ? []
        : [
            {
              label: b().moveTo,
              icon: "arrow-move-right",
              disabled: actions.busy() || !movable(items),
              onClick: () => void actions.moveOrCopy(items),
            },
            { label: b().copyTo, icon: "folder-symlink", disabled: actions.busy(), onClick: () => void actions.moveOrCopy(items, true) },
            {
              label: b().moveToNewFolder,
              icon: "folder-plus",
              disabled: actions.busy() || !canCreate() || !movable(items),
              onClick: () => void actions.moveIntoNewFolder(items),
            },
          ]),
      {
        label: b().trashSelection,
        icon: "trash",
        disabled: actions.busy() || !movable(items),
        onClick: () => void actions.trashItems(items),
      },
    ];
  };
  /** New entries and uploads: the head's "Neu". */
  const addMenu = (): MenuEntry[] => [
    { label: b().newFolder, icon: "folder-plus", onClick: () => void actions.createFolder() },
    { label: b().newFile, icon: "file-plus", onClick: () => void actions.createFile() },
    { label: assets().markdown, icon: "markdown", onClick: () => void actions.createMarkdown() },
    { label: assets().template, icon: "file-description", onClick: () => void actions.createFromTemplate() },
    ...(snapshot().bases.editor
      ? [
          "separator" as const,
          { label: b().newDocument, icon: "file-text", onClick: () => void actions.createDocument("text", b().newDocument) },
          { label: b().newSpreadsheet, icon: "table", onClick: () => void actions.createDocument("spreadsheet", b().newSpreadsheet) },
          {
            label: b().newPresentation,
            icon: "presentation",
            onClick: () => void actions.createDocument("presentation", b().newPresentation),
          },
        ]
      : []),
    "separator",
    { label: b().upload, icon: "upload", onClick: actions.pickFiles },
    { label: b().uploadFolder, icon: "folder-up", onClick: actions.pickFolder },
  ];
  const view = () => preference(snapshot().selectedId);
  // k2b-ui gap: Table has no tree rows (lane Y2: Table tree rows); a storage that keeps the tree view shows its list.
  const grid = () => view().view === "grid" && !searching();
  const changeView = (next: Partial<ViewPreference>) => {
    const base = snapshot().selectedId;
    if (!base) return;
    const value = withView(preferences(), base, { ...view(), ...next });
    setPreferences(value);
    cookies.writeJsonCookie(preferencesCookie, value);
  };
  const viewMenu = (): MenuEntry[] => [
    {
      title: b().view,
      choice: view().view === "grid" ? "grid" : "list",
      onChoose: (value) => changeView({ view: value === "grid" ? "grid" : "list" }),
      items: [
        { label: b().list, icon: "list", value: "list" },
        { label: b().grid, icon: "layout-grid", value: "grid" },
      ],
    },
  ];
  /** The column a press sorts by, and the order a second press gives: the other direction. */
  const sortTarget = (field: "name" | "modified" | "size") => {
    const current = address();
    const direction =
      current.state.sort.field === field ? (current.state.sort.direction === "asc" ? "desc" : "asc") : field === "name" ? "asc" : "desc";
    const href =
      current.mode === "search"
        ? searchStateHref(queries().search.set(current.state, "sort", { field, direction }) ?? current.state)
        : folderStateHref(queries().folder.set(current.state, "sort", { field, direction }) ?? current.state);
    return {
      href,
      onNavigate: (event: LinkNavigateEvent) => {
        if (current.mode === "folder") {
          const next = queries().folder.set(current.state, "sort", { field, direction });
          if (next && snapshot().selectedId) {
            const value = withView(preferences(), snapshot().selectedId!, preferenceOf(next, view()));
            setPreferences(value);
            cookies.writeJsonCookie(preferencesCookie, value);
          }
        }
        onNavigate(event);
      },
    };
  };
  const sortedColumn = () => {
    const index = { name: 0, size: 1, modified: 2 }[address().state.sort.field as "name" | "size" | "modified"];
    return index === undefined
      ? undefined
      : { column: index, direction: address().state.sort.direction === "asc" ? ("ascending" as const) : ("descending" as const) };
  };

  // ── Sidebar ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const navGroups = createMemo((): NavGroup[] => [
    {
      items: [
        ...(hasOverview() ? [{ label: b().allStorage, icon: "layout-grid", href: filesUrl() }] : []),
        { label: b().activity, icon: "history", href: activityUrl({ actor: "me" }) },
        { label: b().favorites, icon: "star", href: viewHref(null, "favorites") },
        { label: b().shares, icon: "world-share", href: viewHref(snapshot().selectedId, "shares") },
      ],
    },
    {
      label: t().storage,
      items: snapshot().bases.items.flatMap((base): NavItem[] => {
        const open = base.id === snapshot().selectedId;
        const item: NavItem = {
          label: label(base),
          icon: base.kind === "users" ? "home" : "users",
          href: filesUrl(base.id),
          onNavigate,
          current: open && !folder() && !searching(),
          ...(base.area === "cloud"
            ? { menu: [{ label: b().activityOfStorage, icon: "history", href: activityUrl({ baseId: base.id }) }] }
            : {}),
        };
        // k2b-ui gap: Nav has no tree (lane Y2: Nav tree, lazy with paging). The open storage folds out the folders
        // down to this one; other branches open from the listing until then.
        const chain = open
          ? ancestors(folder()).map((path) => ({
              label: path.split("/").at(-1) ?? path,
              icon: "folder",
              href: folderHref(path),
              onNavigate,
              nested: true,
              current: path === folder() && !searching(),
            }))
          : [];
        return [item, ...chain];
      }),
    },
  ]);
  const navFoot = (): NavItem[] => [
    ...(snapshot().selectedId && selected()?.status === "existing"
      ? [{ label: b().trashTitle, icon: "trash", href: viewHref(snapshot().selectedId, "trash") }]
      : []),
    {
      label: b().sidebarSearch,
      icon: "search",
      onClick: () => openGlobalSearch({ query: "", scope: { appId: "filesv2", tag: "file", label: t().files, icon: "ti ti-folders" } }),
    },
  ];
  const pathItems = () => {
    const base = selected();
    return [
      ...(hasOverview() ? [{ label: b().allStorage, href: filesUrl() }] : []),
      ...(base ? [{ label: label(base), href: folder() || searching() ? folderHref("") : undefined }] : []),
      ...ancestors(folder()).map((path) => ({
        label: path.split("/").at(-1) ?? path,
        href: path === folder() && !searching() ? undefined : folderHref(path),
      })),
      ...(searching() ? [{ label: b().v2SearchResults }] : []),
    ];
  };
  const uploadAction = () => (canCreate() && !searching() ? { label: b().upload, icon: "upload", onClick: actions.pickFiles } : undefined);

  return (
    <>
      <V2WorkspaceNavigation label={t().files} groups={navGroups()} foot={navFoot()} />
      <actions.Layer />
      <Workspace
        sidebarLabel={b().v2SidebarWidth}
        sidebar={<Nav title={t().files} icon="folders" groups={navGroups()} foot={navFoot()} />}
        detail
        detailEmpty={{ icon: "file", text: b().v2NothingOpen }}
        primary={uploadAction()}
        head={
          <Bar
            start={<Path label={b().v2Where} items={pathItems()} />}
            end={
              <>
                <Input
                  type="search"
                  icon="search"
                  label={b().searchIn(folderName(folder()))}
                  placeholder={b().search}
                  value={address().state.search ?? ""}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") submitSearch(input.value);
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      submitSearch("");
                    }
                  }}
                />
                <Show when={canCreate() && !searching()}>
                  <Menu icon="plus" label={b().add} items={addMenu()} disabled={actions.busy()} />
                  <Button variant="primary" icon="upload" disabled={actions.busy()} onClick={actions.pickFiles}>
                    {b().upload}
                  </Button>
                </Show>
              </>
            }
          />
        }
      >
        <Pane.Split>
          <Pane
            label={t().files}
            width={{ min: 440, default: 640 }}
            scrollKey={`filesv2:${snapshot().selectedId ?? ""}:${folder()}`}
            status={
              <Show when={directory()}>
                <Show when={folderState()}>
                  {(state) => (
                    <FilterBar
                      query={queries().folder}
                      state={state()}
                      onChange={changeFolder}
                      icons={FILTER_ICONS}
                      timeZone={timeZone()}
                      results={lead()}
                    />
                  )}
                </Show>
                <Show when={searchListState()}>
                  {(state) => (
                    <FilterBar
                      query={queries().search}
                      state={state()}
                      onChange={changeSearch}
                      icons={FILTER_ICONS}
                      timeZone={timeZone()}
                      results={lead()}
                    />
                  )}
                </Show>
                <StatusRow
                  lead={lead()}
                  loading={workspace.pending()}
                  select={
                    entries().length
                      ? {
                          label: b().selectAll,
                          checked: chosen().length === 0 ? false : chosenEntries().length === entries().length ? true : "mixed",
                          onChange: (checked) => setChosen(checked ? entries().map((entry) => entry.path) : []),
                        }
                      : undefined
                  }
                  selection={
                    chosenEntries().length
                      ? {
                          count: [
                            b().selectedActions(chosenEntries().length),
                            chosenBytes() ? formatFileViewSize(chosenBytes(), locale()) : "",
                          ]
                            .filter(Boolean)
                            .join(" · "),
                          actions: selectionActions(),
                          clear: { label: b().clear, onClick: () => setChosen([]) },
                        }
                      : undefined
                  }
                  filters={
                    <>
                      <Show when={folderState()}>
                        {(state) => <ListOrder query={queries().folder} state={state()} onChange={changeFolder} />}
                      </Show>
                      <Show when={searchListState()}>
                        {(state) => <ListOrder query={queries().search} state={state()} onChange={changeSearch} />}
                      </Show>
                      <Show when={!searching()}>
                        <Menu icon={grid() ? "layout-grid" : "list"} label={b().view} items={viewMenu()} />
                      </Show>
                    </>
                  }
                />
              </Show>
            }
          >
            <Show when={cursorNotice()}>
              <Notice tone="note" actions={[{ label: b().v2Hide, onClick: () => setCursorNotice(false) }]}>
                {b().cursorReset}
              </Notice>
            </Show>
            {snapshot().bases.issues.map((issue) => (
              <Notice tone="warn" title={t()[issue.area]}>
                {issueText(t(), issue.code)}
              </Notice>
            ))}
            <FolderBody />
          </Pane>
          <Show when={directory() && selected() && openPath() ? openPath() : undefined} keyed>
            {(path) => (
              <EntryDetail
                base={selected()!}
                path={path}
                listed={entries().find((entry) => entry.path === path)}
                initial={snapshot().detail ?? props.initial.detail}
                history={history()}
                actions={actions}
                closeHref={withFile(null)}
                folderName={searching() ? b().v2SearchResults : folderName(folder())}
                onNavigate={onNavigate}
                onEdit={edit}
                onShare={share}
                onShareInbox={shareInbox}
                onChanged={refresh}
              />
            )}
          </Show>
        </Pane.Split>
      </Workspace>
    </>
  );

  /** The folder itself: its states, its description, the files in the making and the entries. */
  function FolderBody() {
    return (
      <Show
        when={directory()}
        fallback={
          <Show
            when={selected()}
            fallback={
              <Empty icon="folder-off" text={snapshot().errorCode ? issueText(t(), snapshot().errorCode) : t().noStorageDescription} />
            }
          >
            {(base) => (
              <Show
                when={base().status === "existing"}
                fallback={<Empty icon="folder-off" text={`${t()[base().status]}: ${issueText(t(), base().reason ?? base().status)}`} />}
              >
                <Failed
                  text={workspace.failure()?.message ?? issueText(t(), snapshot().errorCode)}
                  onRetry={() => void go(workspace.failure()?.source ?? snapshot().source, true)}
                />
              </Show>
            )}
          </Show>
        }
      >
        {(shown) => (
          <Show
            when={!workspace.failure()}
            fallback={<Failed text={workspace.failure()!.message} onRetry={() => void go(workspace.failure()!.source, true)} />}
          >
            <Show when={!pendingSearch()} fallback={<Loading rows={8} lines={2} />}>
              <SearchState failure={shown().failure} />
              <Show when={!shown().failure}>
                <Operations items={actions.operations()} />
                <Show
                  when={grid()}
                  fallback={
                    <Table
                      label={t().files}
                      rows={rows()}
                      rowKey={(row) => row.key}
                      current={openPath() ?? undefined}
                      sort={sortedColumn()}
                      select={{
                        selected: chosen(),
                        onChange: setChosen,
                        all: b().selectAll,
                        row: (row) => b().selectEntry(row.entry.name),
                      }}
                      group={
                        address().mode === "folder" && address().state.group === "kind"
                          ? (row) => {
                              const folders = row.entry.directory;
                              const count = number(rows().filter((other) => other.entry.directory === folders).length);
                              return {
                                key: folders ? "folders" : "files",
                                head: () => <Text weight="strong">{folders ? b().filterFolders : b().filterFiles}</Text>,
                                count,
                                meta: count,
                              };
                            }
                          : undefined
                      }
                      open={(row) => openTarget(row.entry)}
                      empty={emptyState()}
                      phone={(row) => ({
                        lines: [
                          row.entry.name,
                          searching() ? placeOf(row.entry) : row.entry.directory ? b().kindFolder : sizeText(row.entry),
                        ],
                        time: row.fresh ? b().justCreated : day().format(new Date(row.entry.modified)),
                      })}
                      columns={[
                        {
                          title: t().name,
                          width: { min: 160, default: 260 },
                          sort: sortTarget("name"),
                          cell: (row) => {
                            const name = (
                              <Inline>
                                <Icon name={entryIcon(row.entry)} />
                                <Text>{row.entry.name}</Text>
                              </Inline>
                            );
                            return searching() ? { lines: [name, placeOf(row.entry)] } : name;
                          },
                        },
                        {
                          title: t().size,
                          width: { min: 90, default: 110 },
                          align: "end",
                          drop: true,
                          sort: sortTarget("size"),
                          cell: (row) => sizeText(row.entry),
                        },
                        {
                          title: t().modified,
                          width: { min: 130, default: 150 },
                          drop: true,
                          sort: sortTarget("modified"),
                          cell: (row) => (row.fresh ? b().justCreated : date().format(new Date(row.entry.modified))),
                        },
                        {
                          title: b().v2Deeds,
                          cell: (row) => <Menu label={b().v2DeedsFor({ name: row.entry.name })} items={entryMenu(row.entry)} />,
                        },
                      ]}
                    />
                  }
                >
                  {/* k2b-ui gap: Tiles show no picture, size or selection and open as a page (lane Y2: Tiles with
                      images S/M/L); the grid lists symbols until then. */}
                  <Show when={rows().length} fallback={<Empty {...emptyState()} />}>
                    <Tiles
                      label={t().files}
                      items={rows().map((row) => ({
                        icon: entryIcon(row.entry),
                        title: row.entry.name,
                        meta: row.entry.directory ? b().kindFolder : sizeText(row.entry),
                        href: openTarget(row.entry).href,
                      }))}
                    />
                  </Show>
                </Show>
                <Pages shown={shown()} />
              </Show>
            </Show>
          </Show>
        )}
      </Show>
    );
  }

  function emptyState() {
    const filtered = Object.keys(address().state.filters).length > 0;
    if (searching() || filtered)
      return {
        icon: "filter-off",
        text: searching() ? b().noResultsTitle : b().noMatches,
        action: {
          label: b().resetFilters,
          icon: "filter-off",
          href: folderStateHref({ ...queries().folder.reset(), sort: folderState()?.sort ?? queries().folder.reset().sort }),
          onNavigate,
        },
      };
    return { icon: "folder", text: b().emptyTitle };
  }

  /** A search waits in its shape while it runs, so the old results never stand under new words. */
  function pendingSearch() {
    const target = workspace.pendingSource();
    return !!target && directoryContext(target) !== directoryContext(snapshot().source) && !!paramsOf(target).get("q");
  }

  /** The cheaper search of exact names, offered when an indexed search ran out of time. */
  function limitedActions(): TwoActions {
    const state = searchListState();
    const next =
      state && selected()?.indexEnabled && state.filters.match !== "exact" ? queries().search.set(state, "match", "exact") : undefined;
    const folderAction = { label: b().showFolder, href: folderHref(folder()), onNavigate };
    return next ? [{ label: b().searchExactNames, href: searchStateHref(next), onNavigate }, folderAction] : [folderAction];
  }

  /** A search that could not finish says why and offers the cheaper way or the folder. */
  function SearchState(stateProps: { failure?: string }) {
    return (
      <Show when={stateProps.failure}>
        {(code) => (
          <Show
            when={code() === "search_limited"}
            fallback={
              <Notice
                tone="bad"
                title={b().searchFailedTitle}
                actions={[{ label: b().showFolder, href: folderHref(folder()), onNavigate }]}
              >
                {code() === "search_busy" ? b().searchBusy : issueText(t(), code())}
              </Notice>
            }
          >
            <Notice tone="warn" title={b().searchLimitedTitle} actions={limitedActions()}>
              {selected()?.indexEnabled ? b().searchLimitedIndexed : b().searchLimitedScan}
            </Notice>
          </Show>
        )}
      </Show>
    );
  }

  /** Files in the making, such as a merged PDF: their progress or their failure, with their own deeds. */
  function Operations(operationProps: { items: readonly FolderOperation[] }) {
    return (
      <Show when={operationProps.items.length}>
        <List label={b().v2InTheMaking}>
          {operationProps.items.map((operation) => (
            <Row
              icon={operation.state === "failed" ? "alert-triangle" : "loader-2"}
              lines={[operation.name, operation.text]}
              end={
                <>
                  {operation.actions.map((action) => (
                    <Button variant="text" onClick={action.onClick}>
                      {action.label}
                    </Button>
                  ))}
                </>
              }
            />
          ))}
        </List>
      </Show>
    );
  }

  /** More pages of a long folder, and the way back to its first page. */
  function Pages(pageProps: { shown: DirectoryView }) {
    const [loading, setLoading] = createSignal(false);
    const more = async () => {
      setLoading(true);
      const next = new URLSearchParams(params());
      next.set("pages", String((pageProps.shown.loadedPages ?? 1) + 1));
      try {
        await go(`/app/filesv2?${next}`, true);
      } finally {
        setLoading(false);
      }
    };
    return (
      <Show when={pageProps.shown.next || params().get("after")}>
        <Bar
          start={<Text type="meta">{b().pageItems(pageProps.shown.items.length)}</Text>}
          end={
            <>
              <Show when={params().get("after")}>
                <Button variant="text" href={folderHref(folder())} onNavigate={onNavigate}>
                  {t().first}
                </Button>
              </Show>
              <Show when={pageProps.shown.next}>
                <Button icon="chevron-down" busy={loading()} onClick={() => void more()}>
                  {b().loadMore}
                </Button>
              </Show>
            </>
          }
        />
      </Show>
    );
  }
}

/** The browse options of a folder address for the API; a search has its own. */
function browseQueryOf(address: FolderAddress) {
  const options =
    address.mode === "folder"
      ? browseOf(address.state)
      : { sort: "name" as const, order: "asc" as const, type: "all" as const, groupFolders: false };
  return { ...options, groupFolders: options.groupFolders ? ("true" as const) : ("false" as const) };
}
