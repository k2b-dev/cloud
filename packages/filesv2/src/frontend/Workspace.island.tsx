import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, createNavigation, InlineGuidance, Placeholder } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema, type FileEntry } from "../contracts";
import Browser from "./Browser";
import { openShareDialog } from "./ShareDialog";
import TrashView from "./TrashView";
import { useBrowserMessages } from "./browser-messages";
import type { ViewPreference } from "./browser-preferences";
import { IssueMessage } from "./feedback";
import { useFilesMessages } from "./messages";
import { filesUrl } from "./urls";
import { createWorkspaceState, type WorkspaceSnapshot } from "./workspace-state";

const ancestors = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

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
      let directory: WorkspaceSnapshot["directory"] = null;
      if (selected?.status === "existing" && url.searchParams.get("view") !== "trash") {
        const query = { path: url.searchParams.get("path") ?? "", after: url.searchParams.get("after") ?? undefined };
        const q = url.searchParams.get("q")?.trim();
        const scope = url.searchParams.get("scope") === "folder" ? ("folder" as const) : ("tree" as const);
        const response = q
          ? await apiClient.bases[":baseId"].search.$get(
              { param: { baseId: selected.id }, query: { ...query, q, scope } },
              { init: { signal } },
            )
          : await apiClient.bases[":baseId"].entries.$get({ param: { baseId: selected.id }, query }, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        directory = await response.json();
      }
      return { source, bases, selectedId: selected?.id ?? null, directory, errorCode: null };
    },
  });
  const snapshot = workspace.snapshot;
  const selected = () => snapshot().bases.items.find((base) => base.id === snapshot().selectedId);
  const currentPath = () => snapshot().directory?.path ?? "";
  const trashOpen = () => new URL(snapshot().source, "https://files.invalid").searchParams.get("view") === "trash";
  const onNavigate = async (event: LinkNavigateEvent) => {
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
  };
  const go = (target: string, replace = false) =>
    void workspace.navigate(target, () => commitHistory(target, { replace, scroll: "manual" }));
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

  // The sidebar tree loads subfolders on demand; the current folder's ancestors start expanded.
  const [folders, setFolders] = createSignal<Record<string, FileEntry[] | null>>({});
  const [expanded, setExpanded] = createSignal<readonly string[]>(
    props.initial.selectedId
      ? [props.initial.selectedId, ...ancestors(props.initial.directory?.path ?? "").map((path) => `${props.initial.selectedId}:${path}`)]
      : [],
  );
  const treeId = (baseId: string, path: string) => (path ? `${baseId}:${path}` : baseId);
  const loadFolders = async (baseId: string, path: string) => {
    const key = treeId(baseId, path);
    if (folders()[key] !== undefined) return;
    setFolders((current) => ({ ...current, [key]: null }));
    try {
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId }, query: { path } });
      const page = response.ok ? await response.json() : { items: [] };
      setFolders((current) => ({ ...current, [key]: page.items.filter((entry: FileEntry) => entry.directory) }));
    } catch {
      setFolders((current) => ({ ...current, [key]: [] }));
    }
  };
  const ensureLoaded = (ids: readonly string[]) => {
    for (const id of ids) {
      const base = snapshot().bases.items.find((item) => item.id === id || id.startsWith(`${item.id}:`));
      if (!base || base.status !== "existing") continue;
      void loadFolders(base.id, id === base.id ? "" : id.slice(base.id.length + 1));
    }
  };
  // The listing already knows the current folder's subfolders; only ancestors need their own request.
  createEffect(() => {
    const directory = snapshot().directory;
    if (!directory || directory.query) return;
    const key = treeId(directory.base.id, directory.path);
    const dirs = directory.items.filter((entry) => entry.directory);
    setFolders((current) => ({ ...current, [key]: dirs }));
  });
  onMount(() => ensureLoaded(expanded()));
  const Folder = (folderProps: { baseId: string; entry: FileEntry }) => {
    const id = treeId(folderProps.baseId, folderProps.entry.path);
    const children = () => folders()[id];
    return (
      <AppWorkspace.NavTree.Item
        id={id}
        label={folderProps.entry.name}
        icon="ti ti-folder"
        expandedIcon="ti ti-folder-open"
        href={filesUrl(folderProps.baseId, folderProps.entry.path)}
        navigation="enhanced"
        onNavigate={onNavigate}
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
  const centered = (content: () => ReturnType<typeof Placeholder>) => (
    <div class="flex min-h-0 flex-1 items-center justify-center">{content()}</div>
  );
  return (
    <AppWorkspace mobileSurface="flush">
      <WorkspaceNavigationProvider label={t().files} navigation={navigation} />
      <AppWorkspace.Sidebar label={t().storage} collapsible>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarIconGrid columns={2}>
            <AppWorkspace.SidebarIconAction
              icon="ti ti-search"
              label={b().globalSearch}
              onClick={() =>
                openGlobalSearch({ query: "", scope: { appId: "filesv2", tag: "file", label: t().files, icon: "ti ti-folders" } })
              }
            />
            <AppWorkspace.SidebarIconAction
              icon="ti ti-trash"
              label={b().trashNav}
              active={trashOpen()}
              href={`${filesUrl(snapshot().selectedId ?? undefined)}${snapshot().selectedId ? "&" : "?"}view=trash`}
            />
          </AppWorkspace.SidebarIconGrid>
          <AppWorkspace.SidebarBody scrollPreserveKey="filesv2-storage">
            <AppWorkspace.NavTree
              ariaLabel={t().storage}
              selectedId={snapshot().selectedId ? treeId(snapshot().selectedId!, currentPath()) : null}
              expandedIds={expanded()}
              onExpandedIdsChange={(ids) => {
                setExpanded(ids);
                ensureLoaded(ids);
              }}
            >
              <For each={snapshot().bases.items}>
                {(base) => (
                  <AppWorkspace.NavTree.Item
                    id={base.id}
                    label={base.name}
                    icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"}
                    href={filesUrl(base.id)}
                    navigation="enhanced"
                    title={`${base.name} (${t()[base.area]})`}
                    onNavigate={onNavigate}
                  >
                    <Show when={folders()[base.id]?.length}>
                      <For each={folders()[base.id]}>{(entry) => <Folder baseId={base.id} entry={entry} />}</For>
                    </Show>
                  </AppWorkspace.NavTree.Item>
                )}
              </For>
            </AppWorkspace.NavTree>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter>
            <AppWorkspace.SidebarItem href="/app/filesv2/shares" navigation="document" active={false}>
              <AppWorkspace.SidebarItemIcon icon="ti ti-world-share" />
              <AppWorkspace.SidebarItemLabel>{b().shares}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <Show when={!(trashOpen() && selected()?.status === "existing")} fallback={<TrashView base={selected()!} onRestored={(path) => go(filesUrl(selected()!.id, path.split("/").slice(0, -1).join("/"), null, path))} />}>
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
                pending={workspace.pending()}
                error={workspace.failure()?.message}
                onRetry={() => go(retryHref(), true)}
                onOpenDirectory={(path) => go(filesUrl(directory().base.id, path))}
                onSearch={(query, scope) => go(filesUrl(directory().base.id, directory().path, null, null, query, scope))}
                onChanged={(selectPath) => {
                  setFolders({});
                  ensureLoaded(expanded());
                  go(filesUrl(directory().base.id, directory().path, null, selectPath ?? null, directory().query, directory().scope), true);
                }}
                onShare={(paths) =>
                  void openShareDialog({
                    baseId: directory().base.id,
                    kind: "download",
                    paths,
                    defaultTitle: paths.length === 1 ? paths[0]!.split("/").at(-1)! : `${directory().path.split("/").at(-1) || directory().base.name} (${paths.length})`,
                  })
                }
                onShareInbox={(folder) =>
                  void openShareDialog({ baseId: directory().base.id, kind: "inbox", folder, defaultTitle: folder.split("/").at(-1) || directory().base.name })
                }
                onNavigate={onNavigate}
              />
            )}
          </Show>
        </Show>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
