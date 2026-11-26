import { openCommand } from "@k2b/cloud/browser/commands";
import { markHintSeen } from "@k2b/cloud/browser/hints";
import { publishPageContext } from "@k2b/cloud/browser/panel";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, createNavigation, Dropdown, InlineGuidance, MovedHint, Placeholder, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry } from "../contracts";
import ActivityView from "./ActivityView";
import { createActivityVersionLoader } from "./activity-versions";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import type { ViewPreference } from "./browser-preferences";
import Editor from "./Editor";
import { historyExecutionHref } from "./execution-url";
import { IssueMessage } from "./feedback";
import { RECENT_MOVED_HINT } from "./hints";
import { type HistoryActions, type HistoryEnvironment, type HistoryTarget, isCurrent } from "./history-actions";
import {
  entryHref,
  loadActivity,
  loadBatchContext,
  loadChain,
  loadRecent,
  loadRecovery,
  moveActivityBack,
  recheckActivity,
  resolveTarget,
  restoreActivity,
} from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { type ActivityFilters, placeDescriber } from "./history-requests";
import MarkdownDocument from "./MarkdownDocument";
import { MovedNotice } from "./MissingItemView";
import { useFilesMessages } from "./messages";
import { filesPageScope } from "./page-scope";
import SharesOverview from "./SharesOverview";
import StorageOverview from "./StorageOverview";
import { snapshotTitle } from "./trail";
import { activityUrl, filesUrl, parseActivityFilters, screenViewOf, showsOverview } from "./urls";
import { createWorkspaceState, type MovedSnapshot, type WorkspaceSnapshot } from "./workspace-state";

const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};
const viewOf = (source: string) => new URL(source, "https://files.invalid").searchParams.get("view");
const viewUrl = (baseId: string | null | undefined, view: "trash" | "shares" | "recent" | "favorites") =>
  `${filesUrl(baseId ?? undefined)}${baseId ? "&" : "?"}view=${view}`;

export default function Workspace(props: {
  initial: WorkspaceSnapshot;
  preferences?: Record<string, ViewPreference>;
  /** The request's zone from SSR, so history days and ranges match on server and client. */
  timeZone?: string;
  /** Configured history retention, named when a history search finds nothing. */
  retentionDays?: number;
}) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const apiError = async (response: { json: () => Promise<unknown> }) => {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    return new Error(parsed.success ? parsed.data.message : t().unavailable);
  };
  const workspace = createWorkspaceState<WorkspaceSnapshot>({
    initial: props.initial,
    load: async (source, signal) => {
      const url = new URL(source, window.location.origin);
      const basesResponse = await apiClient.bases.$get({}, { init: { signal } });
      if (!basesResponse.ok) throw await apiError(basesResponse);
      const bases = await basesResponse.json();
      const requested = url.searchParams.get("base");
      const overview = showsOverview(url.searchParams, bases.items.length);
      const filters = url.searchParams.get("view") === "activity" ? parseActivityFilters(url.searchParams) : undefined;
      if (filters === null) throw new Error(t().unavailable);
      const selected = overview
        ? undefined
        : filters
          ? bases.items.find((base) => base.id === filters.baseId)
          : requested && url.searchParams.get("view") !== "shares"
            ? bases.items.find((base) => base.id === requested)
            : (bases.items.find((base) => base.status === "existing") ?? bases.items[0]);
      if (requested && !selected && url.searchParams.get("view") !== "shares") throw new Error(t().missingDescription);
      const view = url.searchParams.get("view");
      const file = url.searchParams.get("file");
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
      }
      return {
        source,
        bases,
        selectedId: selected?.id ?? null,
        directory: null,
        errorCode: null,
        shares,
        editor,
        marks,
        now: new Date().toISOString(),
      };
    },
  });
  const snapshot = workspace.snapshot;
  const [contextSource, setContextSource] = createSignal(props.initial.source);
  createEffect(() => setContextSource(snapshot().source));
  createEffect(() => {
    onCleanup(publishPageContext({ scope: filesPageScope({ ...snapshot(), source: contextSource() }) }));
  });
  const overview = () => showsOverview(new URL(snapshot().source, "https://files.invalid").searchParams, snapshot().bases.items.length);
  const hasOverview = () => snapshot().bases.items.length > 1;
  /** A folder, a search, the trash and the favorites are the v2 screen of their own page; these views reach it by loading it. */
  const folderAddress = (target: string) => {
    const url = new URL(target, "https://files.invalid");
    return url.pathname === "/app/filesv2" && screenViewOf(url.searchParams, snapshot().bases.items.length) !== null;
  };
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
  /*
   * Activity filters live in the address. A filter change pushes the address at once and the view reloads its own
   * list, so a failed load keeps the filters beside "Try again". Back and forward load a snapshot, which resets them.
   */
  const [activitySource, setActivitySource] = createSignal(props.initial.source);
  createEffect(on(snapshot, (loaded) => setActivitySource(loaded.source), { defer: true }));
  const activityFilters = createMemo(
    () => parseActivityFilters(new URL(activitySource(), "https://files.invalid").searchParams) ?? {},
    undefined,
    { equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next) },
  );
  const changeActivityFilters = (filters: ActivityFilters) => {
    const target = activityUrl(filters);
    setActivitySource(target);
    workspace.rememberSource(target);
    commitHistory(target, { scroll: "manual" });
  };
  // People to filter by are the actors this person has seen in Activity; the reader has no directory of them.
  const [people, setPeople] = createSignal<Record<string, string>>({});
  const notePeople = (entries: readonly ActivityEntry[]) => {
    const seen = entries.filter((entry) => entry.actor.userId && entry.actor.name && !people()[entry.actor.userId]);
    if (seen.length)
      setPeople((current) => ({ ...current, ...Object.fromEntries(seen.map((entry) => [entry.actor.userId!, entry.actor.name!])) }));
  };
  if (props.initial.activity) notePeople(props.initial.activity.page.items);
  const peopleOptions = () => {
    const known = Object.entries(people()).map(([id, label]) => ({ id, label }));
    const chosen = activityFilters().actor;
    // "me" is the row choice "Me", not a person of the list.
    return chosen && chosen !== "me" && !people()[chosen] ? [...known, { id: chosen, label: h().selectedPerson }] : known;
  };
  const historyEnv = createMemo<HistoryEnvironment>(() => ({
    now: snapshot().now ?? props.initial.now ?? new Date().toISOString(),
    timeZone: props.timeZone ?? "UTC",
    executionHref: historyExecutionHref,
    describePlace: placeDescriber(snapshot().bases.items, b(), locale()),
    onNavigate: (event) => onNavigate(event),
  }));
  /** Opens where a history entry's item is now, after the server checked identity and rights again. */
  let historyTargetRequest: AbortController | undefined;
  const openHistoryTarget = async (target: HistoryTarget) => {
    if (workspace.pending()) return;
    historyTargetRequest?.abort();
    historyTargetRequest = new AbortController();
    const signal = AbortSignal.any([historyTargetRequest.signal, workspace.navigationSignal()]);
    try {
      const resolved = await resolveTarget(target, h().actionFailed, signal);
      if (!signal.aborted) await go(entryHref(resolved), false, signal);
    } catch (error) {
      if (!signal.aborted) toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
    }
  };
  /*
   * Actions of vanished items run through the recovery endpoints, which resolve the entry again with current rights,
   * identity and journals. A refusal (403, 409) surfaces beside the action; nothing here trusts a stored entry.
   */
  const activityActions: HistoryActions = {
    loadVersion: createActivityVersionLoader(() => h().historyFailed),
    onContact: async ({ userId }) => {
      const signal = workspace.navigationSignal();
      try {
        const opened = await openCommand("chat.conversation.compose", { userId }, {}, signal);
        if (!signal.aborted && !opened) toast.error(h().actionFailed);
      } catch (error) {
        if (!signal.aborted) toast.error(error instanceof Error && error.message ? error.message : h().actionFailed);
      }
    },
    onOpen: openHistoryTarget,
    onShowVersions: (entry) => {
      const side = isCurrent(entry.after) ? entry.after : isCurrent(entry.before) ? entry.before : null;
      if (side) void openHistoryTarget({ kind: "side", side });
    },
    loadRecovery: (entry, signal) => loadRecovery(entry, signal, h().recoveryFailed),
    onRestoreTrash: (entry, options) => restoreActivity(entry, options?.name, h().actionFailed),
    onMoveBack: async (entry) => {
      await moveActivityBack(entry, h().actionFailed);
    },
    onRecheck: async (entry) => {
      await recheckActivity(entry, h().actionFailed);
    },
    onShowTrash: (trash) => void go(viewUrl(trash.baseId, "trash")),
    onOpenOldLocation: (place) => void go(filesUrl(place.baseId, place.path)),
  };
  let editorGuard: (() => Promise<boolean>) | null = null;
  const onNavigate = async (event: LinkNavigateEvent) => {
    workspace.cancelNavigationActions();
    if (editorGuard && !(await editorGuard())) return;
    const target = `${event.url.pathname}${event.url.search}`;
    if (event.url.pathname !== "/app/filesv2" || folderAddress(target)) {
      event.fallback();
      return;
    }
    await workspace.navigate(target, () => {
      if (target === `${window.location.pathname}${window.location.search}` || event.replace)
        event.replaceWith(target, { scroll: "manual" });
      else event.push(target, { scroll: "manual" });
    });
  };
  const go = async (target: string, replace = false, signal?: AbortSignal) => {
    if (!signal) workspace.cancelNavigationActions();
    if (editorGuard && !(await editorGuard())) return;
    if (signal?.aborted) return;
    if (folderAddress(target)) {
      // Leaving the editor asked about unsaved changes above; the guard must not ask the browser again.
      editorGuard = null;
      window.location.assign(target);
      return;
    }
    await workspace.navigate(target, () => commitHistory(target, { replace, scroll: "manual" }));
  };
  // Once, at the sidebar's Activity: Recent now lives there. The server decides; dismissing or using it ends it.
  const [recentMovedHint, setRecentMovedHint] = createSignal(!!props.initial.hints?.recentMoved);
  const dialogLifetime = new AbortController();
  onCleanup(() => dialogLifetime.abort());
  // The sidebar's Activity replaces Recent: it always opens "Me" across all storage (approved 08.11.); inside Activity
  // the entry keeps the current filters. A storage's own history is "Activity of this storage" in its menu.
  const activityHref = () => (currentView() === "activity" ? activityUrl(activityFilters()) : activityUrl({ actor: "me" }));
  const navigation = createNavigation({
    items: () => [
      ...(hasOverview()
        ? [
            {
              id: "all-storage",
              label: b().allStorage,
              icon: "ti ti-layout-grid",
              href: filesUrl(),
              active: overview(),
              navigation: "enhanced" as const,
              scroll: "manual" as const,
            },
          ]
        : []),
      {
        id: "activity",
        label: b().activity,
        icon: "ti ti-history",
        href: activityHref(),
        active: currentView() === "activity",
        navigation: "enhanced" as const,
        scroll: "manual" as const,
      },
      {
        id: "favorites",
        label: b().favorites,
        icon: "ti ti-star",
        href: viewUrl(null, "favorites"),
        active: currentView() === "favorites",
        navigation: "enhanced" as const,
      },
      {
        id: "shares",
        label: b().shares,
        icon: "ti ti-world-share",
        href: viewUrl(snapshot().selectedId, "shares"),
        active: currentView() === "shares",
        navigation: "enhanced" as const,
      },
      ...snapshot().bases.items.map((base) => ({
        id: base.id,
        label: baseLabel(base, b(), locale()),
        icon: base.kind === "users" ? "ti ti-home" : "ti ti-users",
        href: filesUrl(base.id),
        active: snapshot().selectedId === base.id && currentView() !== "activity",
        navigation: "enhanced" as const,
        scroll: "manual" as const,
      })),
    ],
    onNavigate,
  });
  onMount(() =>
    onCleanup(
      listenPopState(async ({ url }) => {
        workspace.cancelNavigationActions();
        if (url.pathname !== "/app/filesv2") return;
        const target = `${url.pathname}${url.search}`;
        if (folderAddress(target)) return window.location.reload();
        if (target === workspace.committedSource() && !workspace.pending()) return;
        const previous = workspace.committedSource();
        if (editorGuard && !(await editorGuard())) {
          commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false });
          return;
        }
        void workspace.navigate(
          target,
          () => {},
          () => commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false }),
        );
      }),
    ),
  );
  // The way up (the path above the title, or Alt+↑) moves between folders in place like every other link here,
  // so uploads keep running and an open editor can ask about unsaved changes first.
  onMount(() =>
    onCleanup(
      layout.handleUp((href) => {
        const url = new URL(href, window.location.origin);
        if (url.pathname !== "/app/filesv2") return false;
        void go(`${url.pathname}${url.search}`);
        return true;
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
  onMount(() => ensureLoaded(expanded()));
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
  const editorBack = (launch: NonNullable<WorkspaceSnapshot["editor"]>) =>
    filesUrl(launch.base.id, launch.entry.path.split("/").slice(0, -1).join("/"), null, launch.entry.path);
  // The shell shows the folder path, or the open document below its folder, and follows every in-page navigation.
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
  /** An old folder address: where the item went, never a silent redirect. */
  const MovedHere = (movedProps: { moved: MovedSnapshot }) => {
    const base = () => snapshot().bases.items.find((item) => item.id === movedProps.moved.baseId);
    const name = () => movedProps.moved.path.split("/").at(-1) ?? movedProps.moved.path;
    return (
      <MovedNotice
        entry={movedProps.moved.entry}
        chain={movedProps.moved.chain}
        openedItem={{ name: name(), directory: true }}
        oldAddress={[...(base() ? [baseLabel(base()!, b(), locale())] : []), ...movedProps.moved.path.split("/")]}
        env={historyEnv()}
        actions={{ onOpen: openHistoryTarget }}
        historyHref={activityUrl({ q: name() })}
      />
    );
  };
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
    <>
      <Show when={currentView() !== "edit"} fallback={editorView()}>
        <AppWorkspace
          class={`filesv2-workspace ${currentView() === "activity" ? "filesv2-workspace--activity" : snapshot().moved ? "filesv2-workspace--moved" : ""}`}
          mobileSurface="flush"
        >
          <WorkspaceNavigationProvider label={t().files} navigation={navigation} />
          <AppWorkspace.Sidebar label={t().storage} collapsible defaultSize={248}>
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarBody scrollPreserveKey="filesv2-storage">
                {/* Places across all storage first, as approved: overview, recent, favorites, links and activity. */}
                <AppWorkspace.SidebarSection>
                  <Show when={hasOverview()}>
                    <AppWorkspace.SidebarItem href={filesUrl()} navigation="enhanced" onNavigate={onNavigate} active={overview()}>
                      <AppWorkspace.SidebarItemIcon icon="ti ti-layout-grid" />
                      <AppWorkspace.SidebarItemLabel>{b().allStorage}</AppWorkspace.SidebarItemLabel>
                    </AppWorkspace.SidebarItem>
                  </Show>
                  {/* Activity takes Recent's place: "Me" is what Recent listed, and the files you changed. */}
                  <AppWorkspace.SidebarItem
                    class="filesv2-sidebar-activity"
                    href={activityHref()}
                    navigation="enhanced"
                    scroll="manual"
                    onNavigate={onNavigate}
                    active={currentView() === "activity"}
                  >
                    <AppWorkspace.SidebarItemIcon icon="ti ti-history" />
                    <AppWorkspace.SidebarItemLabel>{b().activity}</AppWorkspace.SidebarItemLabel>
                  </AppWorkspace.SidebarItem>
                  <MovedHint
                    open={recentMovedHint()}
                    target={() => document.querySelector<HTMLElement>(".filesv2-sidebar-activity") ?? undefined}
                    placement="right"
                    onDismiss={() => {
                      setRecentMovedHint(false);
                      markHintSeen(RECENT_MOVED_HINT);
                    }}
                    action={{ label: b().openActivity, href: activityUrl({ actor: "me" }) }}
                  >
                    <strong>{b().recentMovedTitle}</strong> {b().recentMovedText}
                  </MovedHint>
                  <AppWorkspace.SidebarItem
                    href={viewUrl(null, "favorites")}
                    navigation="enhanced"
                    onNavigate={onNavigate}
                    active={currentView() === "favorites"}
                  >
                    <AppWorkspace.SidebarItemIcon icon="ti ti-star" />
                    <AppWorkspace.SidebarItemLabel>{b().favorites}</AppWorkspace.SidebarItemLabel>
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarItem
                    href={viewUrl(snapshot().selectedId, "shares")}
                    navigation="enhanced"
                    onNavigate={onNavigate}
                    active={currentView() === "shares"}
                  >
                    <AppWorkspace.SidebarItemIcon icon="ti ti-world-share" />
                    <AppWorkspace.SidebarItemLabel>{b().shares}</AppWorkspace.SidebarItemLabel>
                    <Show when={snapshot().shares} keyed>
                      {(page) => (
                        <AppWorkspace.SidebarItemMeta>
                          {page.items.length}
                          {page.next ? "+" : ""}
                        </AppWorkspace.SidebarItemMeta>
                      )}
                    </Show>
                  </AppWorkspace.SidebarItem>
                </AppWorkspace.SidebarSection>
                <AppWorkspace.SidebarSection title={t().storage}>
                  <AppWorkspace.NavTree
                    ariaLabel={t().storage}
                    selectedId={
                      // The trash opens from its storage root's listing, so that root stays highlighted while it is open.
                      snapshot().selectedId && (!currentView() || currentView() === "trash")
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
                          actions={
                            // A storage's own history: everyone's changes there. Activity in the sidebar is "Me".
                            <Show when={base.area === "cloud"}>
                              <Dropdown.Root
                                items={[
                                  {
                                    label: b().activityOfStorage,
                                    icon: "ti ti-history",
                                    action: () => void go(activityUrl({ baseId: base.id })),
                                  },
                                ]}
                                align="end"
                              >
                                <Dropdown.Trigger
                                  iconOnly
                                  size="xs"
                                  variant="ghost"
                                  label={`${b().moreActions}: ${baseLabel(base, b(), locale())}`}
                                >
                                  <i class="ti ti-dots" aria-hidden="true" />
                                </Dropdown.Trigger>
                              </Dropdown.Root>
                            </Show>
                          }
                        >
                          <Show when={base.status === "existing"}>
                            <For each={folders()[treeId(base.id, "")] ?? []}>{(entry) => <Folder baseId={base.id} entry={entry} />}</For>
                            <MoreFolders baseId={base.id} path="" />
                          </Show>
                        </AppWorkspace.NavTree.Item>
                      )}
                    </For>
                  </AppWorkspace.NavTree>
                </AppWorkspace.SidebarSection>
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
              </AppWorkspace.SidebarFooter>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <Show
              when={currentView() !== "activity"}
              fallback={
                <AppWorkspace.Main class="flex min-h-0 flex-col">
                  <ActivityView
                    env={historyEnv()}
                    actions={activityActions}
                    filters={activityFilters()}
                    onFiltersChange={changeActivityFilters}
                    bases={snapshot().bases.items.map((base) => ({ id: base.id, label: baseLabel(base, b(), locale()) }))}
                    people={peopleOptions()}
                    initial={snapshot().activity}
                    load={async (request, signal) => {
                      const page = await loadActivity(request, signal, h().errorTitle);
                      notePeople(page.items);
                      return page;
                    }}
                    loadChain={(entry, signal) => loadChain(entry, signal, h().chainFailed)}
                    loadBatch={(entry, signal) => loadBatchContext(entry, signal, h().batchFailed)}
                    retentionDays={props.retentionDays ?? 365}
                    opened={{ initial: snapshot().marks ?? null, load: (signal) => loadRecent(signal, b().loadFailed) }}
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
                  when={!overview() || !!problem()}
                  fallback={
                    <StorageOverview
                      bases={snapshot().bases.items}
                      issues={snapshot().bases.issues}
                      favorites={snapshot().favoritesPreview}
                      env={historyEnv()}
                      onNavigate={onNavigate}
                    />
                  }
                >
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
                          when={snapshot().moved}
                          keyed
                          fallback={
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
                          }
                        >
                          {(moved) => <MovedHere moved={moved} />}
                        </Show>
                      </Show>
                    </Show>
                  </AppWorkspace.Main>
                </Show>
              </Show>
            </Show>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Show>
    </>
  );
}
