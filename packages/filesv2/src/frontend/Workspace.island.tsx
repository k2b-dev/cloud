import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigate as commitHistory, type LinkNavigateEvent, listenPopState } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, createNavigation, InlineGuidance, Placeholder } from "@k2b/ui";
import { For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema } from "../contracts";
import Browser from "./Browser";
import type { BrowserPreferences } from "./browser-preferences";
import { IssueMessage } from "./feedback";
import { useFilesMessages } from "./messages";
import { filesUrl } from "./urls";
import { createWorkspaceState, type WorkspaceSnapshot } from "./workspace-state";

export default function Workspace(props: { initial: WorkspaceSnapshot; preferences?: BrowserPreferences }) {
  const t = useFilesMessages();
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
      if (selected?.status === "existing") {
        const query = { path: url.searchParams.get("path") ?? "", after: url.searchParams.get("after") ?? undefined };
        const q = url.searchParams.get("q")?.trim();
        const response = q
          ? await apiClient.bases[":baseId"].search.$get({ param: { baseId: selected.id }, query: { ...query, q } }, { init: { signal } })
          : await apiClient.bases[":baseId"].entries.$get({ param: { baseId: selected.id }, query }, { init: { signal } });
        if (!response.ok) throw await apiError(response);
        directory = await response.json();
      }
      return { source, bases, selectedId: selected?.id ?? null, directory, errorCode: null };
    },
  });
  const snapshot = workspace.snapshot;
  const selected = () => snapshot().bases.items.find((base) => base.id === snapshot().selectedId);
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
  const navigation = createNavigation({
    items: () =>
      snapshot().bases.items.map((base) => ({
        id: base.id,
        label: `${base.name} (${t()[base.area]})`,
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
  const after = () => new URL(snapshot().source, "https://files.invalid").searchParams.get("after") ?? undefined;
  const openDirectory = (base: string, path: string) =>
    void workspace.navigate(filesUrl(base, path), () => commitHistory(filesUrl(base, path), { scroll: "manual" }));
  const problem = () => workspace.failure()?.message ?? snapshot().errorCode;
  const retryHref = () => workspace.failure()?.source ?? snapshot().source;
  const retry = () => (
    <ButtonLink size="sm" variant="secondary" href={retryHref()} navigation="enhanced" onNavigate={onNavigate}>
      {t().refresh}
    </ButtonLink>
  );
  return (
    <AppWorkspace mobileSurface="flush">
      <WorkspaceNavigationProvider label={t().files} navigation={navigation} />
      <AppWorkspace.Sidebar label={t().storage} collapsible>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="filesv2-storage">
            <AppWorkspace.SidebarSection title={t().storage}>
              <For each={snapshot().bases.items}>
                {(base) => (
                  <AppWorkspace.SidebarItem
                    href={filesUrl(base.id)}
                    navigation="enhanced"
                    onNavigate={onNavigate}
                    active={snapshot().selectedId === base.id}
                    title={`${base.name} (${t()[base.area]})`}
                  >
                    <AppWorkspace.SidebarItemIcon icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"} />
                    <AppWorkspace.SidebarItemLabel>{base.name}</AppWorkspace.SidebarItemLabel>
                    <AppWorkspace.SidebarItemMeta>{t()[base.area]}</AppWorkspace.SidebarItemMeta>
                  </AppWorkspace.SidebarItem>
                )}
              </For>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <Show
          when={snapshot().directory}
          fallback={
            <AppWorkspace.Main class="flex min-h-0 flex-col gap-3 p-[var(--ui-space-shell)]" aria-busy={workspace.pending()}>
              <Show
                when={!workspace.pending()}
                fallback={
                  <div class="flex min-h-0 flex-1 items-center justify-center">
                    <Placeholder state="loading" variant="panel" description={t().loadingFiles} />
                  </div>
                }
              >
                <Show
                  when={!problem()}
                  fallback={
                    <div class="flex min-h-0 flex-1 items-center justify-center">
                      <Placeholder
                        state="error"
                        variant="panel"
                        title={t().loadFailed}
                        description={workspace.failure()?.message ?? <IssueMessage code={snapshot().errorCode} />}
                        action={retry()}
                      />
                    </div>
                  }
                >
                  <Show
                    when={selected()}
                    fallback={
                      <div class="flex min-h-0 flex-1 items-center justify-center">
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
                      </div>
                    }
                  >
                    {(base) => (
                      <Show
                        when={base().status === "existing"}
                        fallback={
                          <div class="flex min-h-0 flex-1 items-center justify-center">
                            <Placeholder
                              variant="panel"
                              state={base().status === "conflict" || base().status === "unknown" ? "error" : "empty"}
                              icon="ti ti-folder-off"
                              title={t()[base().status]}
                              description={<IssueMessage code={base().reason ?? base().status} />}
                              action={retry()}
                            />
                          </div>
                        }
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
              after={after()}
              source={snapshot().source}
              detail={snapshot().detail}
              preferences={props.preferences}
              issues={snapshot().bases.issues}
              onSelectionSource={workspace.rememberSource}
              pending={workspace.pending()}
              error={workspace.failure()?.message}
              onRetry={() => void workspace.navigate(retryHref(), () => commitHistory(retryHref(), { replace: true, scroll: "manual" }))}
              onOpenDirectory={(path) => openDirectory(directory().base.id, path)}
              onSearch={(query) => {
                const target = filesUrl(directory().base.id, directory().path, null, null, query);
                void workspace.navigate(target, () => commitHistory(target, { scroll: "manual" }));
              }}
              onCreated={(path) => {
                const target = filesUrl(directory().base.id, directory().path, null, path);
                void workspace.navigate(target, () => commitHistory(target, { replace: true, scroll: "manual" }));
              }}
              onNavigate={onNavigate}
            />
          )}
        </Show>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
