import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, createNavigation, InlineGuidance, Placeholder, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry, type MarkedEntry } from "../contracts";
import Browser from "./Browser";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { browseOptions, browseQuery, parsePreferences, type ViewPreference, viewFor } from "./browser-preferences";
import Editor from "./Editor";
import { IssueMessage } from "./feedback";
import MarkdownDocument from "./MarkdownDocument";
import { MarksMenu, MarksSidebarItem, openMarksDialog } from "./MarksMenu";
import { useFilesMessages } from "./messages";
import { openShareDialog } from "./ShareDialog";
import SharesOverview from "./SharesOverview";
import TrashView from "./TrashView";
import { editorUrl, filesUrl } from "./urls";
import { createWorkspaceState, type WorkspaceSnapshot } from "./workspace-state";

const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};
const viewOf = (source: string) => new URL(source, "https://files.invalid").searchParams.get("view");
const viewUrl = (baseId: string | null | undefined, view: "trash" | "shares" | "recent" | "favorites") =>
  `${filesUrl(baseId ?? undefined)}${baseId ? "&" : "?"}view=${view}`;
/** Listings are polled while the tab is visible; Filegate has no change feed yet. */
const LIVE_REFRESH_MS = 20_000;
const fingerprint = (items: readonly FileEntry[]) => JSON.stringify(items);

export default function Workspace(props: { initial: WorkspaceSnapshot; preferences?: Record<string, ViewPreference>; cloudUrl: string }) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const locale = useLocale();
  const apiError = async (response: { json: () => Promise<unknown> }) => {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    return new Error(parsed.success ? parsed.data.message : t().unavailable);
  };
  const invalidCursors = new Set<string>();
  const [cursorNotice, setCursorNotice] = createSignal(
    new URL(props.initial.source, "https://files.invalid").searchParams.get("refreshed") === "true",
  );
  const preference = (baseId: string) => viewFor(parsePreferences(typeof document === "undefined" ? undefined : document.cookie), baseId);
  const workspace = createWorkspaceState({
    initial: props.initial,
    load: async (source, signal) => {
      const url = new URL(source, window.location.origin);
      const basesResponse = await apiClient.bases.$get({}, { init: { signal } });
      if (!basesResponse.ok) throw await apiError(basesResponse);
      const bases = await basesResponse.json();
      const requested = url.searchParams.get("base");
      const selected =
        requested && url.searchParams.get("view") !== "shares"
          ? bases.items.find((base) => base.id === requested)
          : (bases.items.find((base) => base.status === "existing") ?? bases.items[0]);
      if (requested && !selected && url.searchParams.get("view") !== "shares") throw new Error(t().missingDescription);
      const view = url.searchParams.get("view");
      const file = url.searchParams.get("file");
      let directory: WorkspaceSnapshot["directory"] = null;
      let shares: WorkspaceSnapshot["shares"];
      let editor: WorkspaceSnapshot["editor"];
      let marks: WorkspaceSnapshot["marks"];
      if (view === "shares") {
        const response = await apiClient.shares.$get({ query: {} }, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        shares = await response.json();
      } else if (view === "recent" || view === "favorites") {
        const response =
          view === "recent"
            ? await apiClient.recent.$get({}, { init: { signal } })
            : await apiClient.favorites.$get({}, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        marks = await response.json();
      } else if (view === "edit" && file && selected?.status === "existing") {
        const response = await apiClient.bases[":baseId"].editor.$post(
          { param: { baseId: selected.id }, json: { path: file } },
          { init: { signal } },
        );
        if (!response.ok) throw await apiError(response);
        editor = await response.json();
      } else if (selected?.status === "existing" && view !== "trash") {
        const query = {
          path: url.searchParams.get("path") ?? "",
          after: url.searchParams.get("after") ?? undefined,
          ...browseQuery(browseOptions(url.searchParams, preference(selected.id))),
        };
        const q = url.searchParams.get("q")?.trim();
        const response = q
          ? await apiClient.bases[":baseId"].search.$get(
              {
                param: { baseId: selected.id },
                query: { ...query, q, scope: url.searchParams.get("scope") === "folder" ? "folder" : "tree" },
              },
              { init: { signal } },
            )
          : await apiClient.bases[":baseId"].entries.$get({ param: { baseId: selected.id }, query }, { init: { signal } });
        if (!response.ok) {
          const error = ErrorSchema.safeParse(await response.json());
          if (query.after && !signal.aborted && error.success && error.data.code === "cursor_invalid") invalidCursors.add(source);
          throw new Error(error.success ? error.data.message : t().unavailable);
        }
        directory = await response.json();
      }
      return { source, bases, selectedId: selected?.id ?? null, directory, errorCode: null, shares, editor, marks };
    },
  });
  const snapshot = workspace.snapshot;
  const [preserveSelection, setPreserveSelection] = createSignal(false);
  let refreshBrowserBranches: ((signal: AbortSignal) => Promise<void>) | null = null;
  let activePoll: AbortController | undefined;
  createEffect(() => {
    if (workspace.pending()) activePoll?.abort();
  });
  // Every load returns fresh base objects; the sidebar tree only re-renders when a base really changed.
  const bases = createMemo<WorkspaceSnapshot["bases"]["items"]>((previous = []) => {
    const next = snapshot().bases.items.map((base) => {
      const known = previous.find((item) => item.id === base.id);
      return known &&
        known.name === base.name &&
        known.status === base.status &&
        known.kind === base.kind &&
        known.locationKey === base.locationKey
        ? known
        : base;
    });
    return previous.length === next.length && previous.every((item, index) => item === next[index]) ? previous : next;
  });
  const selected = () => snapshot().bases.items.find((base) => base.id === snapshot().selectedId);
  const currentPath = () => snapshot().directory?.path ?? "";
  const currentView = () => viewOf(snapshot().source);
  const resetCursor = async (target: string) => {
    if (!invalidCursors.delete(target)) return;
    const url = new URL(target, window.location.origin);
    url.searchParams.delete("after");
    const first = `${url.pathname}${url.search}`;
    setCursorNotice(true);
    await workspace.navigate(first, () => commitHistory(first, { replace: true, scroll: "manual" }));
  };
  let editorGuard: (() => Promise<boolean>) | null = null;
  const onNavigate = async (event: LinkNavigateEvent) => {
    if (editorGuard && !(await editorGuard())) return;
    setCursorNotice(false);
    if (event.url.pathname !== "/app/filesv2") {
      event.fallback();
      return;
    }
    const target = `${event.url.pathname}${event.url.search}`;
    await workspace.navigate(target, () => {
      if (target === `${window.location.pathname}${window.location.search}` || event.replace)
        event.replaceWith(target, { scroll: "manual" });
      else event.push(target, { scroll: "manual" });
    });
    await resetCursor(target);
  };
  const go = async (target: string, replace = false) => {
    if (editorGuard && !(await editorGuard())) return;
    setCursorNotice(false);
    await workspace.navigate(target, () => commitHistory(target, { replace, scroll: "manual" }));
    await resetCursor(target);
  };
  const currentBrowse = () =>
    browseOptions(new URL(snapshot().source, "https://files.invalid").searchParams, preference(snapshot().selectedId ?? ""));
  const [marksRevision, setMarksRevision] = createSignal(0);
  const dialogLifetime = new AbortController();
  onCleanup(() => dialogLifetime.abort());
  const navigation = createNavigation({
    items: () => [
      ...snapshot().bases.items.map((base) => ({
        id: base.id,
        label: baseLabel(base, b(), locale()),
        icon: base.kind === "users" ? "ti ti-home" : "ti ti-users",
        href: filesUrl(base.id),
        active: snapshot().selectedId === base.id,
        navigation: "enhanced" as const,
        scroll: "manual" as const,
      })),
      { id: "recent", label: b().recent, icon: "ti ti-history", action: "recent" },
      { id: "favorites", label: b().favorites, icon: "ti ti-star", action: "favorites" },
      {
        id: "shares",
        label: b().shares,
        icon: "ti ti-world-share",
        href: viewUrl(snapshot().selectedId, "shares"),
        navigation: "enhanced" as const,
      },
    ],
    onAction: (kind) => {
      if (kind === "recent" || kind === "favorites")
        void openMarksDialog({
          kind,
          title: kind === "recent" ? b().recent : b().favorites,
          onOpen: openMarked,
          signal: dialogLifetime.signal,
        });
    },
    onNavigate,
  });
  onMount(() =>
    onCleanup(
      listenPopState(async ({ url }) => {
        if (url.pathname !== "/app/filesv2") return;
        const target = `${url.pathname}${url.search}`;
        if (target === workspace.committedSource() && !workspace.pending()) return;
        const previous = workspace.committedSource();
        if (editorGuard && !(await editorGuard())) {
          commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false });
          return;
        }
        void workspace
          .navigate(
            target,
            () => {},
            () => commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false }),
          )
          .then(() => resetCursor(target));
      }),
    ),
  );

  /*
   * Sidebar tree: subfolders are loaded on demand and lists are swapped only once fresh data arrived.
   * After every navigation exactly the current path is expanded; the user may then open or close
   * any branch until the next navigation.
   */
  const [folders, setFolders] = createSignal<Record<string, FileEntry[]>>({});
  const treeId = (baseId: string, path: string) =>
    JSON.stringify([baseId, snapshot().bases.items.find((base) => base.id === baseId)?.locationKey ?? null, path]);
  const pathIds = (baseId: string | null, path: string) =>
    baseId ? [treeId(baseId, ""), ...ancestors(path).map((item) => treeId(baseId, item))] : [];
  const [expanded, setExpanded] = createSignal<readonly string[]>(pathIds(props.initial.selectedId, props.initial.directory?.path ?? ""));
  const mergeFolders = (key: string, dirs: FileEntry[]) =>
    setFolders((current) => {
      const previous = current[key] ?? [];
      const next = dirs.map((entry) => previous.find((item) => item.path === entry.path && item.name === entry.name) ?? entry);
      if (previous.length === next.length && previous.every((item, index) => item === next[index])) return current;
      return { ...current, [key]: next };
    });
  const inFlight = new Map<string, AbortController>();
  const folderPages = new Map<string, number>();
  const [folderCursors, setFolderCursors] = createSignal<Record<string, string | null>>({});
  onCleanup(() => {
    for (const request of inFlight.values()) request.abort();
  });
  const loadFolders = async (baseId: string, path: string, force = false, after?: string, background?: AbortSignal) => {
    const key = treeId(baseId, path);
    if (background && inFlight.has(key)) return;
    if ((!force && inFlight.has(key)) || (!force && !after && folders()[key] !== undefined)) return;
    inFlight.get(key)?.abort();
    const request = new AbortController();
    inFlight.set(key, request);
    const signal = background ? AbortSignal.any([background, request.signal]) : request.signal;
    try {
      const items = after ? [...(folders()[key] ?? [])] : [];
      let next = after;
      let pages = after ? (folderPages.get(key) ?? 1) : 0;
      const pageCount = background ? (folderPages.get(key) ?? 1) : 1;
      for (let index = 0; index < pageCount; index++) {
        signal.throwIfAborted();
        const response = await apiClient.bases[":baseId"].entries.$get(
          { param: { baseId }, query: { path, after: next, type: "directories" } },
          { init: { signal } },
        );
        if (!response.ok) {
          const error = ErrorSchema.safeParse(await response.clone().json());
          if (next && error.success && error.data.code === "cursor_invalid" && !signal.aborted) {
            inFlight.delete(key);
            folderPages.delete(key);
            mergeFolders(key, []);
            setCursorNotice(true);
            await loadFolders(baseId, path, true, undefined, background);
            return;
          }
          if (!signal.aborted && key === treeId(baseId, path) && (Number(response.status) === 403 || Number(response.status) === 404)) {
            mergeFolders(key, []);
            setFolderCursors((value) => ({ ...value, [key]: null }));
          }
          return;
        }
        const page = await response.json();
        if (signal.aborted || key !== treeId(baseId, path)) return;
        items.push(...page.items.filter((entry) => entry.directory));
        next = page.next ?? undefined;
        pages++;
        if (!next) break;
      }
      mergeFolders(key, items);
      folderPages.set(key, pages);
      setFolderCursors((value) => ({ ...value, [key]: next ?? null }));
    } catch {
      // Keep whatever the tree showed before; the listing itself reports failures.
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }
  };
  const ensureLoaded = (ids: readonly string[], force = false) => {
    for (const id of ids) {
      const [baseId, locationKey, path] = JSON.parse(id);
      const base = snapshot().bases.items.find((item) => item.id === baseId && (item.locationKey ?? null) === locationKey);
      if (!base || base.status !== "existing") continue;
      void loadFolders(base.id, path, force);
    }
  };
  createEffect(() => {
    const directory = snapshot().directory;
    if (!directory || directory.query) return;
    if (!directory.next && !after() && currentBrowse().type !== "files") {
      mergeFolders(
        treeId(directory.base.id, directory.path),
        directory.items.filter((entry) => entry.directory),
      );
      setFolderCursors((value) => ({ ...value, [treeId(directory.base.id, directory.path)]: null }));
    } else void loadFolders(directory.base.id, directory.path, true);
  });
  createEffect(
    on(
      () => JSON.stringify([snapshot().selectedId, selected()?.locationKey, currentPath(), currentView()]),
      () => {
        const baseId = snapshot().selectedId;
        if (!baseId || !snapshot().directory) return;
        const needed = pathIds(baseId, currentPath());
        setExpanded(needed);
        ensureLoaded(needed.filter((id) => id !== treeId(baseId, currentPath())));
      },
      { defer: true },
    ),
  );
  onMount(() => ensureLoaded(expanded()));
  // Poll the current page and the branches actually visible in either tree. A root's mtime says nothing about deeper files.
  onMount(() => {
    let polling = false;
    const timer = setInterval(async () => {
      const directory = snapshot().directory;
      if (polling || document.visibilityState !== "visible" || workspace.pending() || !directory || directory.query || currentView())
        return;
      polling = true;
      const request = new AbortController();
      activePoll = request;
      const timeout = setTimeout(() => request.abort(), LIVE_REFRESH_MS);
      try {
        const after = new URL(workspace.committedSource(), window.location.origin).searchParams.get("after") ?? undefined;
        const response = await apiClient.bases[":baseId"].entries
          .$get(
            { param: { baseId: directory.base.id }, query: { path: directory.path, after, ...browseQuery(currentBrowse()) } },
            { init: { signal: request.signal } },
          )
          .catch(() => null);
        if (!response?.ok) {
          const error = response ? ErrorSchema.safeParse(await response.json()) : null;
          if (after && error?.success && error.data.code === "cursor_invalid") {
            invalidCursors.add(workspace.committedSource());
            await resetCursor(workspace.committedSource());
          }
          return;
        }
        if (snapshot().directory !== directory) return;
        const page = await response.json();
        if (request.signal.aborted || workspace.pending() || snapshot().directory !== directory) return;
        const unchanged =
          fingerprint(page.items) === fingerprint(directory.items) &&
          page.next === directory.next &&
          page.base.locationKey === directory.base.locationKey &&
          page.actions?.create === directory.actions?.create;
        const currentTreeId = treeId(directory.base.id, directory.path);
        const reuseCurrent = !after && !page.next && currentBrowse().type !== "files" && (folderPages.get(currentTreeId) ?? 1) <= 1;
        if (reuseCurrent) {
          mergeFolders(
            treeId(directory.base.id, directory.path),
            page.items.filter((entry) => entry.directory),
          );
          setFolderCursors((value) => ({ ...value, [treeId(directory.base.id, directory.path)]: page.next }));
        }
        for (const id of [...expanded()]) {
          if (request.signal.aborted || workspace.pending() || snapshot().directory !== directory) return;
          const [baseId, locationKey, path] = JSON.parse(id);
          if (!expanded().includes(id) || (reuseCurrent && id === currentTreeId)) continue;
          if (path && !expanded().includes(treeId(baseId, ""))) continue;
          if (
            ancestors(path)
              .slice(0, -1)
              .some((parent) => !expanded().includes(treeId(baseId, parent)))
          )
            continue;
          const base = snapshot().bases.items.find((item) => item.id === baseId && (item.locationKey ?? null) === locationKey);
          if (base?.status === "existing") await loadFolders(baseId, path, true, undefined, request.signal);
        }
        if (request.signal.aborted || workspace.pending() || snapshot().directory !== directory) return;
        await refreshBrowserBranches?.(request.signal);
        if (unchanged || request.signal.aborted || workspace.pending() || snapshot().directory !== directory) return;
        setPreserveSelection(true);
        try {
          await go(workspace.committedSource(), true);
        } finally {
          setPreserveSelection(false);
        }
      } catch {
        // A failed background refresh leaves the current navigation intact; the next visible poll retries.
      } finally {
        clearTimeout(timeout);
        if (activePoll === request) activePoll = undefined;
        polling = false;
      }
    }, LIVE_REFRESH_MS);
    onCleanup(() => {
      activePoll?.abort();
      clearInterval(timer);
    });
  });
  const openMarked = (item: MarkedEntry) =>
    void go(
      item.entry.directory
        ? filesUrl(item.base.id, item.entry.path)
        : filesUrl(item.base.id, item.entry.path.split("/").slice(0, -1).join("/"), null, item.entry.path),
    );
  // The tree row being navigated to shows a spinner until the workspace has moved there.
  const [navigating, setNavigating] = createSignal<string | null>(null);
  const withSpinner = async (id: string, run: () => Promise<void>) => {
    setNavigating(id);
    try {
      await run();
    } finally {
      setNavigating((current) => (current === id ? null : current));
    }
  };
  const goTree = (id: string, target: string) => void withSpinner(id, () => go(target));
  // Item props are read once by the tree; the spinner marker lives inside the label so only this row updates.
  const treeLabel = (id: string, name: string) => (
    <span class="filesv2-nav-label">
      <Show when={navigating() === id}>
        <i class="filesv2-nav-spinner" aria-hidden="true" />
      </Show>
      {name}
    </span>
  );
  const MoreFolders = (moreProps: { baseId: string; path: string }) => {
    const id = () => treeId(moreProps.baseId, moreProps.path);
    return (
      <Show when={folderCursors()[id()]}>
        {(cursor) => (
          <AppWorkspace.NavTree.Item
            id={`${id()}:more`}
            label={b().more}
            icon="ti ti-dots"
            onSelect={() => void loadFolders(moreProps.baseId, moreProps.path, false, cursor())}
          />
        )}
      </Show>
    );
  };
  const Folder = (folderProps: { baseId: string; entry: FileEntry }) => {
    const id = () => treeId(folderProps.baseId, folderProps.entry.path);
    const children = () => folders()[id()];
    return (
      <AppWorkspace.NavTree.Item
        id={id()}
        label={treeLabel(id(), folderProps.entry.name)}
        icon="ti ti-folder"
        expandedIcon="ti ti-folder-open"
        href={filesUrl(folderProps.baseId, folderProps.entry.path)}
        navigation="enhanced"
        onNavigate={(event) => withSpinner(id(), () => onNavigate(event))}
      >
        <Show when={children()?.length}>
          <For each={children()}>{(child) => <Folder baseId={folderProps.baseId} entry={child} />}</For>
        </Show>
        <MoreFolders baseId={folderProps.baseId} path={folderProps.entry.path} />
      </AppWorkspace.NavTree.Item>
    );
  };
  const after = () => new URL(snapshot().source, "https://files.invalid").searchParams.get("after") ?? undefined;
  const problem = () => workspace.failure()?.message ?? snapshot().errorCode;
  const retryHref = () => workspace.failure()?.source ?? snapshot().source;
  const retry = () => (
    <ButtonLink size="sm" variant="secondary" href={retryHref()} navigation="enhanced" onNavigate={onNavigate}>
      {t().refresh}
    </ButtonLink>
  );
  const centered = (content: () => ReturnType<typeof Placeholder>) => (
    <div class="flex min-h-0 flex-1 items-center justify-center">{content()}</div>
  );
  const trashId = (baseId: string) => `${baseId}:trash`;
  const editorBack = (launch: NonNullable<WorkspaceSnapshot["editor"]>) =>
    filesUrl(launch.base.id, launch.entry.path.split("/").slice(0, -1).join("/"), null, launch.entry.path);
  // The shell's title follows the open document; the app name returns once the editor is left.
  createEffect(
    on(
      () => (currentView() === "edit" ? (snapshot().editor?.entry.path ?? "") : null),
      (path) => {
        const launch = snapshot().editor;
        layout.update({
          breadcrumbs:
            path && launch ? [{ title: t().files, href: editorBack(launch) }, { title: launch.entry.name }] : [{ title: t().files }],
        });
      },
      { defer: true },
    ),
  );
  const editorView = () => (
    <AppWorkspace mobileSurface="flush">
      <WorkspaceNavigationProvider label={t().files} navigation={navigation} />
      <AppWorkspace.Content>
        <Show
          when={snapshot().editor}
          keyed
          fallback={
            <AppWorkspace.Main class="flex min-h-0 flex-col gap-3 p-[var(--ui-space-shell)]" aria-busy={workspace.pending()}>
              <Show
                when={!workspace.pending()}
                fallback={centered(() => <Placeholder state="loading" variant="panel" description={b().editorLoading} />)}
              >
                {centered(() => (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={b().editorFailed}
                    description={workspace.failure()?.message ?? <IssueMessage code={snapshot().errorCode} />}
                    action={retry()}
                  />
                ))}
              </Show>
            </AppWorkspace.Main>
          }
        >
          {(launch) =>
            launch.kind === "markdown" ? (
              <MarkdownDocument
                launch={launch}
                onGuard={(guard) => {
                  editorGuard = guard;
                }}
                onBack={() => void go(editorBack(launch))}
              />
            ) : (
              <Editor launch={launch} onBack={() => void go(editorBack(launch))} />
            )
          }
        </Show>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
  return (
    <Show when={currentView() !== "edit"} fallback={editorView()}>
      <AppWorkspace mobileSurface="flush">
        <WorkspaceNavigationProvider label={t().files} navigation={navigation} />
        <AppWorkspace.Sidebar label={t().storage} collapsible>
          <AppWorkspace.SidebarDesktop>
            <AppWorkspace.SidebarBody scrollPreserveKey="filesv2-storage">
              <AppWorkspace.NavTree
                ariaLabel={t().storage}
                selectedId={
                  snapshot().selectedId && currentView() === "trash"
                    ? trashId(snapshot().selectedId!)
                    : snapshot().selectedId && !currentView()
                      ? treeId(snapshot().selectedId!, currentPath())
                      : null
                }
                expandedIds={expanded()}
                onExpandedIdsChange={(ids) => {
                  setExpanded(ids);
                  ensureLoaded(ids);
                }}
              >
                <For each={bases()}>
                  {(base) => (
                    <AppWorkspace.NavTree.Item
                      id={treeId(base.id, "")}
                      label={treeLabel(treeId(base.id, ""), baseLabel(base, b(), locale()))}
                      icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"}
                      href={filesUrl(base.id)}
                      navigation="enhanced"
                      meta={base.kind === "users" ? <span class="text-xs text-dimmed">{base.name}</span> : undefined}
                      title={`${base.kind === "users" ? `${baseLabel(base, b(), locale())} · ${base.name}` : baseLabel(base, b(), locale())} (${t()[base.area]})`}
                      onNavigate={(event) => withSpinner(treeId(base.id, ""), () => onNavigate(event))}
                    >
                      <Show when={base.status === "existing"}>
                        <For each={folders()[treeId(base.id, "")] ?? []}>{(entry) => <Folder baseId={base.id} entry={entry} />}</For>
                        <MoreFolders baseId={base.id} path="" />
                        <AppWorkspace.NavTree.Item
                          id={trashId(base.id)}
                          label={treeLabel(trashId(base.id), b().trashTitle)}
                          icon="ti ti-trash"
                          href={viewUrl(base.id, "trash")}
                          navigation="enhanced"
                          onNavigate={(event) => withSpinner(trashId(base.id), () => onNavigate(event))}
                        />
                      </Show>
                    </AppWorkspace.NavTree.Item>
                  )}
                </For>
              </AppWorkspace.NavTree>
            </AppWorkspace.SidebarBody>
            <AppWorkspace.SidebarFooter>
              <AppWorkspace.SidebarItem
                icon="ti ti-search"
                title={b().globalSearch}
                onClick={() =>
                  openGlobalSearch({ query: "", scope: { appId: "filesv2", tag: "file", label: t().files, icon: "ti ti-folders" } })
                }
              >
                {b().sidebarSearch}
              </AppWorkspace.SidebarItem>
              <MarksSidebarItem kind="recent" onOpen={openMarked} revision={marksRevision()} />
              <MarksSidebarItem kind="favorites" onOpen={openMarked} revision={marksRevision()} />
              <AppWorkspace.SidebarItem
                href={viewUrl(snapshot().selectedId, "shares")}
                navigation="enhanced"
                onNavigate={onNavigate}
                active={currentView() === "shares"}
              >
                <AppWorkspace.SidebarItemIcon icon="ti ti-world-share" />
                <AppWorkspace.SidebarItemLabel>{b().shares}</AppWorkspace.SidebarItemLabel>
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarFooter>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          <Show
            when={currentView() !== "recent" && currentView() !== "favorites"}
            fallback={
              <AppWorkspace.Main class="p-3">
                <MarksMenu
                  kind={currentView() === "recent" ? "recent" : "favorites"}
                  open
                  close={() => {}}
                  onOpen={openMarked}
                  revision={marksRevision()}
                />
              </AppWorkspace.Main>
            }
          >
            <Show
              when={currentView() !== "shares"}
              fallback={
                <SharesOverview
                  shares={snapshot().shares ?? { items: [], next: null }}
                  baseId={snapshot().selectedId}
                  onNavigate={onNavigate}
                />
              }
            >
              <Show
                when={!(currentView() === "trash" && selected()?.status === "existing")}
                fallback={
                  <TrashView
                    base={selected()!}
                    onNavigate={onNavigate}
                    onRestored={(path) => void go(filesUrl(selected()!.id, path.split("/").slice(0, -1).join("/"), null, path))}
                  />
                }
              >
                <Show
                  when={snapshot().directory}
                  fallback={
                    <AppWorkspace.Main class="flex min-h-0 flex-col gap-3 p-[var(--ui-space-shell)]" aria-busy={workspace.pending()}>
                      <Show
                        when={!workspace.pending()}
                        fallback={centered(() => <Placeholder state="loading" variant="panel" description={t().loadingFiles} />)}
                      >
                        <Show
                          when={!problem()}
                          fallback={centered(() => (
                            <Placeholder
                              state="error"
                              variant="panel"
                              title={t().loadFailed}
                              description={workspace.failure()?.message ?? <IssueMessage code={snapshot().errorCode} />}
                              action={retry()}
                            />
                          ))}
                        >
                          <Show
                            when={selected()}
                            fallback={centered(() => (
                              <Placeholder
                                variant="panel"
                                icon="ti ti-folder-off"
                                title={t().noStorage}
                                description={
                                  <div class="flex flex-col gap-2">
                                    <p>{t().noStorageDescription}</p>
                                    <For each={snapshot().bases.issues}>
                                      {(issue) => (
                                        <p>
                                          <strong>{t()[issue.area]}: </strong>
                                          <IssueMessage code={issue.code} />
                                        </p>
                                      )}
                                    </For>
                                  </div>
                                }
                                action={retry()}
                              />
                            ))}
                          >
                            {(base) => (
                              <Show
                                when={base().status === "existing"}
                                fallback={centered(() => (
                                  <Placeholder
                                    variant="panel"
                                    state={base().status === "conflict" || base().status === "unknown" ? "error" : "empty"}
                                    icon="ti ti-folder-off"
                                    title={t()[base().status]}
                                    description={<IssueMessage code={base().reason ?? base().status} />}
                                    action={retry()}
                                  />
                                ))}
                              >
                                <For each={snapshot().bases.issues}>
                                  {(issue) => (
                                    <InlineGuidance tone="info">
                                      <strong>{t()[issue.area]}: </strong>
                                      <IssueMessage code={issue.code} />
                                    </InlineGuidance>
                                  )}
                                </For>
                              </Show>
                            )}
                          </Show>
                        </Show>
                      </Show>
                    </AppWorkspace.Main>
                  }
                >
                  {(directory) => (
                    <Browser
                      directory={directory()}
                      bases={snapshot().bases.items}
                      cloudUrl={props.cloudUrl}
                      after={after()}
                      source={snapshot().source}
                      detail={snapshot().detail}
                      preferences={props.preferences}
                      issues={snapshot().bases.issues}
                      onSelectionSource={workspace.rememberSource}
                      onMarksChanged={() => setMarksRevision((value) => value + 1)}
                      onBranchRefreshReady={(refresh) => {
                        refreshBrowserBranches = refresh;
                      }}
                      pending={workspace.pending()}
                      preserveSelection={preserveSelection()}
                      error={workspace.failure()?.message}
                      notice={cursorNotice() ? b().cursorReset : undefined}
                      onRetry={() => void go(retryHref(), true)}
                      onOpenDirectory={(path) =>
                        goTree(
                          treeId(directory().base.id, path),
                          filesUrl(directory().base.id, path, null, null, null, null, currentBrowse()),
                        )
                      }
                      onOpenTrash={() => goTree(trashId(directory().base.id), viewUrl(directory().base.id, "trash"))}
                      onSearch={(query) =>
                        void go(filesUrl(directory().base.id, directory().path, null, null, query, null, currentBrowse()))
                      }
                      onBrowseChange={(options) =>
                        void go(filesUrl(directory().base.id, directory().path, null, null, directory().query, directory().scope, options))
                      }
                      onChanged={(selectPath) => {
                        setMarksRevision((value) => value + 1);
                        // Refresh every loaded tree level in place; lists are swapped only when fresh data arrives.
                        ensureLoaded(Object.keys(folders()), true);
                        return go(
                          filesUrl(
                            directory().base.id,
                            directory().path,
                            null,
                            selectPath ?? null,
                            directory().query,
                            directory().scope,
                            currentBrowse(),
                          ),
                          true,
                        );
                      }}
                      onShare={(paths) =>
                        void openShareDialog({
                          baseId: directory().base.id,
                          kind: "download",
                          paths,
                          defaultTitle:
                            paths.length === 1
                              ? paths[0]!.split("/").at(-1)!
                              : `${directory().path.split("/").at(-1) || baseLabel(directory().base, b(), locale())} (${paths.length})`,
                        })
                      }
                      onShareInbox={(folder) =>
                        void openShareDialog({
                          baseId: directory().base.id,
                          kind: "inbox",
                          folder,
                          defaultTitle: folder.split("/").at(-1) || baseLabel(directory().base, b(), locale()),
                        })
                      }
                      editor={snapshot().bases.editor}
                      onEdit={(entry) => void go(editorUrl(directory().base.id, entry.path))}
                      onNavigate={onNavigate}
                    />
                  )}
                </Show>
              </Show>
            </Show>
          </Show>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Show>
  );
}
