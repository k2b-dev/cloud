import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, createNavigation, InlineGuidance, Placeholder } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import MarkedList from "./MarkedList";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry, type MarkedEntry } from "../contracts";
import Browser from "./Browser";
import Editor from "./Editor";
import { useBrowserMessages } from "./browser-messages";
import type { ViewPreference } from "./browser-preferences";
import { IssueMessage } from "./feedback";
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
const viewUrl = (baseId: string | null | undefined, view: "trash" | "shares" | "recent" | "favorites") => `${filesUrl(baseId ?? undefined)}${baseId ? "&" : "?"}view=${view}`;
/** Listings are polled while the tab is visible; Filegate has no change feed yet. */
const LIVE_REFRESH_MS = 20_000;
const fingerprint = (items: readonly FileEntry[]) => items.map((item) => `${item.path}|${item.size}|${item.modified}`).join("\n");

export default function Workspace(props: { initial: WorkspaceSnapshot; preferences?: Record<string, ViewPreference>; cloudUrl: string }) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const apiError = async (response: { json: () => Promise<unknown> }) => {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    return new Error(parsed.success ? parsed.data.message : t().unavailable);
  };
  const workspace = createWorkspaceState({
    initial: props.initial,
    load: async (source, signal) => {
      const url = new URL(source, window.location.origin);
      const basesResponse = await apiClient.bases.$get({}, { init: { signal } });
      if (!basesResponse.ok) throw await apiError(basesResponse);
      const bases = await basesResponse.json();
      const requested = url.searchParams.get("base");
      const selected = requested
        ? bases.items.find((base) => base.id === requested)
        : (bases.items.find((base) => base.status === "existing") ?? bases.items[0]);
      if (requested && !selected) throw new Error(t().missingDescription);
      const view = url.searchParams.get("view");
      const file = url.searchParams.get("file");
      let directory: WorkspaceSnapshot["directory"] = null;
      let shares: WorkspaceSnapshot["shares"];
      let editor: WorkspaceSnapshot["editor"];
      let marks: WorkspaceSnapshot["marks"];
      if (view === "shares") {
        const response = await apiClient.shares.$get({}, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        shares = await response.json();
      } else if (view === "recent" || view === "favorites") {
        const response = view === "recent" ? await apiClient.recent.$get({}, { init: { signal } }) : await apiClient.favorites.$get({}, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        marks = await response.json();
      } else if (view === "edit" && file && selected?.status === "existing") {
        const response = await apiClient.bases[":baseId"].editor.$post({ param: { baseId: selected.id }, json: { path: file } }, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        editor = await response.json();
      } else if (selected?.status === "existing" && view !== "trash") {
        const query = { path: url.searchParams.get("path") ?? "", after: url.searchParams.get("after") ?? undefined };
        const q = url.searchParams.get("q")?.trim();
        const response = q
          ? await apiClient.bases[":baseId"].search.$get({ param: { baseId: selected.id }, query: { ...query, q, scope: "tree" } }, { init: { signal } })
          : await apiClient.bases[":baseId"].entries.$get({ param: { baseId: selected.id }, query }, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        directory = await response.json();
      }
      return { source, bases, selectedId: selected?.id ?? null, directory, errorCode: null, shares, editor, marks };
    },
  });
  const snapshot = workspace.snapshot;
  // Every load returns fresh base objects; the sidebar tree only re-renders when a base really changed.
  const bases = createMemo<WorkspaceSnapshot["bases"]["items"]>((previous = []) => {
    const next = snapshot().bases.items.map((base) => {
      const known = previous.find((item) => item.id === base.id);
      return known && known.name === base.name && known.status === base.status && known.kind === base.kind ? known : base;
    });
    return previous.length === next.length && previous.every((item, index) => item === next[index]) ? previous : next;
  });
  const selected = () => snapshot().bases.items.find((base) => base.id === snapshot().selectedId);
  const currentPath = () => snapshot().directory?.path ?? "";
  const currentView = () => viewOf(snapshot().source);
  const onNavigate = async (event: LinkNavigateEvent) => {
    if (event.url.pathname !== "/app/filesv2") {
      event.fallback();
      return;
    }
    const target = `${event.url.pathname}${event.url.search}`;
    await workspace.navigate(target, () => {
      if (target === `${window.location.pathname}${window.location.search}` || event.replace) event.replaceWith(target, { scroll: "manual" });
      else event.push(target, { scroll: "manual" });
    });
  };
  const go = (target: string, replace = false) => workspace.navigate(target, () => commitHistory(target, { replace, scroll: "manual" }));
  const navigation = createNavigation({
    items: () =>
      snapshot().bases.items.map((base) => ({
        id: base.id,
        label: base.name,
        icon: base.kind === "users" ? "ti ti-home" : "ti ti-users",
        href: filesUrl(base.id),
        active: snapshot().selectedId === base.id,
        navigation: "enhanced",
        scroll: "manual",
      })),
    onNavigate,
  });
  onMount(() =>
    onCleanup(
      listenPopState(({ url }) => {
        if (url.pathname !== "/app/filesv2") return;
        const target = `${url.pathname}${url.search}`;
        if (target === workspace.committedSource() && !workspace.pending()) return;
        const previous = workspace.committedSource();
        void workspace.navigate(
          target,
          () => {},
          () => commitHistory(previous, { replace: true, scroll: "manual", viewTransition: false }),
        );
      }),
    ),
  );

  /*
   * Sidebar tree: subfolders are loaded on demand and lists are swapped only once fresh data arrived.
   * After every navigation exactly the current path is expanded; the user may then open or close
   * any branch until the next navigation.
   */
  const [folders, setFolders] = createSignal<Record<string, FileEntry[]>>({});
  const treeId = (baseId: string, path: string) => (path ? `${baseId}:${path}` : baseId);
  const pathIds = (baseId: string | null, path: string) => (baseId ? [baseId, ...ancestors(path).map((item) => `${baseId}:${item}`)] : []);
  const [expanded, setExpanded] = createSignal<readonly string[]>(pathIds(props.initial.selectedId, props.initial.directory?.path ?? ""));
  const mergeFolders = (key: string, dirs: FileEntry[]) =>
    setFolders((current) => {
      const previous = current[key] ?? [];
      const next = dirs.map((entry) => previous.find((item) => item.path === entry.path && item.name === entry.name) ?? entry);
      if (previous.length === next.length && previous.every((item, index) => item === next[index])) return current;
      return { ...current, [key]: next };
    });
  const inFlight = new Set<string>();
  const loadFolders = async (baseId: string, path: string, force = false) => {
    const key = treeId(baseId, path);
    if (inFlight.has(key) || (!force && folders()[key] !== undefined)) return;
    inFlight.add(key);
    try {
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId }, query: { path } });
      if (!response.ok) return;
      const page = await response.json();
      mergeFolders(key, page.items.filter((entry: FileEntry) => entry.directory));
    } catch {
      // Keep whatever the tree showed before; the listing itself reports failures.
    } finally {
      inFlight.delete(key);
    }
  };
  const baseOf = (id: string) => snapshot().bases.items.find((item) => item.id === id || id.startsWith(`${item.id}:`));
  const ensureLoaded = (ids: readonly string[], force = false) => {
    for (const id of ids) {
      const base = baseOf(id);
      if (!base || base.status !== "existing") continue;
      void loadFolders(base.id, id === base.id ? "" : id.slice(base.id.length + 1), force);
    }
  };
  createEffect(() => {
    const directory = snapshot().directory;
    if (!directory || directory.query) return;
    mergeFolders(treeId(directory.base.id, directory.path), directory.items.filter((entry) => entry.directory));
  });
  createEffect(
    on(
      () => `${snapshot().selectedId ?? ""}:${currentPath()}:${currentView() ?? ""}`,
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
  // Other users and Collabora change folders without telling this tab; the current page is compared every few seconds.
  onMount(() => {
    const timer = setInterval(async () => {
      const directory = snapshot().directory;
      if (document.visibilityState !== "visible" || workspace.pending() || !directory || directory.query || currentView()) return;
      const after = new URL(snapshot().source, window.location.origin).searchParams.get("after") ?? undefined;
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId: directory.base.id }, query: { path: directory.path, after } }).catch(() => null);
      if (!response?.ok || snapshot().directory !== directory) return;
      const page = await response.json();
      if (fingerprint(page.items) === fingerprint(directory.items)) return;
      ensureLoaded(Object.keys(folders()), true);
      void go(snapshot().source, true);
    }, LIVE_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
  const openMarked = (item: MarkedEntry) =>
    void go(item.entry.directory ? filesUrl(item.base.id, item.entry.path) : filesUrl(item.base.id, item.entry.path.split("/").slice(0, -1).join("/"), null, item.entry.path));
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
  const Folder = (folderProps: { baseId: string; entry: FileEntry }) => {
    const id = treeId(folderProps.baseId, folderProps.entry.path);
    const children = () => folders()[id];
    return (
      <AppWorkspace.NavTree.Item
        id={id}
        label={treeLabel(id, folderProps.entry.name)}
        icon="ti ti-folder"
        expandedIcon="ti ti-folder-open"
        href={filesUrl(folderProps.baseId, folderProps.entry.path)}
        navigation="enhanced"
        onNavigate={(event) => withSpinner(id, () => onNavigate(event))}
      >
        <Show when={children()?.length}>
          <For each={children()}>{(child) => <Folder baseId={folderProps.baseId} entry={child} />}</For>
        </Show>
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
  const centered = (content: () => ReturnType<typeof Placeholder>) => <div class="flex min-h-0 flex-1 items-center justify-center">{content()}</div>;
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
          breadcrumbs: path && launch ? [{ title: t().files, href: editorBack(launch) }, { title: launch.entry.name }] : [{ title: t().files }],
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
          fallback={
            <AppWorkspace.Main class="flex min-h-0 flex-col gap-3 p-[var(--ui-space-shell)]" aria-busy={workspace.pending()}>
              <Show when={!workspace.pending()} fallback={centered(() => <Placeholder state="loading" variant="panel" description={b().editorLoading} />)}>
                {centered(() => (
                  <Placeholder state="error" variant="panel" title={b().editorFailed} description={workspace.failure()?.message ?? <IssueMessage code={snapshot().errorCode} />} action={retry()} />
                ))}
              </Show>
            </AppWorkspace.Main>
          }
        >
          {(launch) => <Editor launch={launch()} onBack={() => void go(editorBack(launch()))} />}
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
          <AppWorkspace.SidebarIconGrid columns={2}>
            <AppWorkspace.SidebarIconAction
              icon="ti ti-search"
              label={b().globalSearch}
              onClick={() => openGlobalSearch({ query: "", scope: { appId: "filesv2", tag: "file", label: t().files, icon: "ti ti-folders" } })}
            />
          </AppWorkspace.SidebarIconGrid>
          <AppWorkspace.SidebarBody scrollPreserveKey="filesv2-storage">
            <AppWorkspace.NavTree
              ariaLabel={t().storage}
              selectedId={
                snapshot().selectedId && currentView() === "trash" ? trashId(snapshot().selectedId!) : snapshot().selectedId && !currentView() ? treeId(snapshot().selectedId!, currentPath()) : null
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
                    id={base.id}
                    label={treeLabel(base.id, base.name)}
                    icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"}
                    href={filesUrl(base.id)}
                    navigation="enhanced"
                    title={`${base.name} (${t()[base.area]})`}
                    onNavigate={(event) => withSpinner(base.id, () => onNavigate(event))}
                  >
                    <Show when={base.status === "existing"}>
                      <For each={folders()[base.id] ?? []}>{(entry) => <Folder baseId={base.id} entry={entry} />}</For>
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
            <AppWorkspace.SidebarItem href={viewUrl(snapshot().selectedId, "recent")} navigation="enhanced" onNavigate={onNavigate} active={currentView() === "recent"}>
              <AppWorkspace.SidebarItemIcon icon="ti ti-history" />
              <AppWorkspace.SidebarItemLabel>{b().recent}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem href={viewUrl(snapshot().selectedId, "favorites")} navigation="enhanced" onNavigate={onNavigate} active={currentView() === "favorites"}>
              <AppWorkspace.SidebarItemIcon icon="ti ti-star" />
              <AppWorkspace.SidebarItemLabel>{b().favorites}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem href={viewUrl(snapshot().selectedId, "shares")} navigation="enhanced" onNavigate={onNavigate} active={currentView() === "shares"}>
              <AppWorkspace.SidebarItemIcon icon="ti ti-world-share" />
              <AppWorkspace.SidebarItemLabel>{b().shares}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <Show
          when={currentView() !== "recent" && currentView() !== "favorites"}
          fallback={<MarkedList kind={currentView() === "recent" ? "recent" : "favorites"} items={snapshot().marks ?? []} onOpen={openMarked} />}
        >
        <Show when={currentView() !== "shares"} fallback={<SharesOverview shares={snapshot().shares ?? []} />}>
          <Show
            when={!(currentView() === "trash" && selected()?.status === "existing")}
            fallback={<TrashView base={selected()!} onRestored={(path) => void go(filesUrl(selected()!.id, path.split("/").slice(0, -1).join("/"), null, path))} />}
          >
            <Show
              when={snapshot().directory}
              fallback={
                <AppWorkspace.Main class="flex min-h-0 flex-col gap-3 p-[var(--ui-space-shell)]" aria-busy={workspace.pending()}>
                  <Show when={!workspace.pending()} fallback={centered(() => <Placeholder state="loading" variant="panel" description={t().loadingFiles} />)}>
                    <Show
                      when={!problem()}
                      fallback={centered(() => (
                        <Placeholder state="error" variant="panel" title={t().loadFailed} description={workspace.failure()?.message ?? <IssueMessage code={snapshot().errorCode} />} action={retry()} />
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
                  pending={workspace.pending()}
                  error={workspace.failure()?.message}
                  onRetry={() => void go(retryHref(), true)}
                  onOpenDirectory={(path) => goTree(treeId(directory().base.id, path), filesUrl(directory().base.id, path))}
                  onOpenTrash={() => goTree(trashId(directory().base.id), viewUrl(directory().base.id, "trash"))}
                  onSearch={(query) => void go(filesUrl(directory().base.id, directory().path, null, null, query))}
                  onChanged={(selectPath) => {
                    // Refresh every loaded tree level in place; lists are swapped only when fresh data arrives.
                    ensureLoaded(Object.keys(folders()), true);
                    void go(filesUrl(directory().base.id, directory().path, after(), selectPath ?? null, directory().query), true);
                  }}
                  onShare={(paths) =>
                    void openShareDialog({
                      baseId: directory().base.id,
                      kind: "download",
                      paths,
                      defaultTitle: paths.length === 1 ? paths[0]!.split("/").at(-1)! : `${directory().path.split("/").at(-1) || directory().base.name} (${paths.length})`,
                    })
                  }
                  onShareInbox={(folder) => void openShareDialog({ baseId: directory().base.id, kind: "inbox", folder, defaultTitle: folder.split("/").at(-1) || directory().base.name })}
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
