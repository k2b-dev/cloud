import { navigateTo } from "@k2b/ssr/nav";
import { Button, NoticeCard, Placeholder, prompts, useLocale } from "@k2b/ui";
import { type Accessor, createResource, createSignal, For, Show } from "solid-js";
import { advancedMessages } from "./advanced-messages";
import { artifactClient } from "./client";
import { openDatabaseDialog, openDataDialog } from "./DataDialogs";
import { artifactMessages } from "./messages";
import { openPublicationInfo, publishArtifact } from "./publication";
import { runnerHref } from "./runner-contracts";
import { openSecretsDialog } from "./SecretsDialog";
import { StudioPermissions } from "./StudioPermissions";
import type { ArtifactBundle, ArtifactSummary } from "./service";
export function createArtifactActions(props: {
  userId: string;
  refresh?: () => Promise<unknown>;
  app?: Accessor<ArtifactBundle | undefined>;
  editorDirty?: Accessor<boolean>;
  setApp?: (app: ArtifactBundle) => void;
  setSelectedVersion?: (version: number | undefined) => void;
  view?: "app" | "edit" | "database";
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [sharing, setSharing] = createSignal<ArtifactSummary>();
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [access] = createResource(() => sharing()?.id, artifactClient.access);
  async function action(run: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await run();
      await props.refresh?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t().REQUEST_FAILED);
    } finally {
      setBusy(false);
    }
  }
  const open = (id: string) => navigateTo(`/app/assistant/apps/${id}`);
  const openRunner = async (item: ArtifactSummary) => {
    if (item.publishedRevision) {
      navigateTo(runnerHref(item.id));
      return;
    }
    if (props.editorDirty?.()) {
      await prompts.alert(a().saveBeforePublish, { title: t().publish });
      return;
    }
    await openPublicationInfo({
      id: item.id,
      revision: item.revision,
      published: false,
      locale: locale(),
      onPublished: async () => {
        if (props.app?.()?.id === item.id) props.setApp?.(await artifactClient.get(item.id));
        await props.refresh?.();
        navigateTo(runnerHref(item.id));
      },
    });
  };
  const edit = (id: string) => action(async () => navigateTo((await artifactClient.editChat(id)).href));
  const share = async (item: ArtifactSummary) => {
    setSharing(item);
    await prompts.dialog<void>(
      () => (
        <div class="assistant-version-list">
          <NoticeCard tone="info" title={t().sharedCodeTitle} detail={t().sharedCodeHelp} />
          <Show when={!item.publishedRevision}>
            <NoticeCard tone="warning" title={t().unpublishedAccess} detail={t().unpublishedAccessHelp} />
          </Show>
          <Show when={!access.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
            <Show when={!access.error && access()} keyed fallback={<Placeholder state="error" title={t().loadFailed} />}>
              {(entries) => (
                <StudioPermissions
                  entries={entries}
                  loadProjects={() => artifactClient.projects(item.id)}
                  grant={(principal, level) => artifactClient.grant(item.id, principal, level)}
                  change={(id, level) => artifactClient.changeGrant(item.id, id, level)}
                />
              )}
            </Show>
          </Show>
        </div>
      ),
      { title: `${t().share} · ${item.title}`, size: "medium" },
    );
    setSharing(undefined);
    await props.refresh?.();
  };
  const publish = async (item: ArtifactSummary) => {
    if (props.app?.()?.id === item.id && props.editorDirty?.()) {
      await prompts.alert(a().saveBeforePublish, { title: t().publish });
      return;
    }
    await action(async () => {
      if (!(await publishArtifact(item, locale()))) return;
      if (props.app?.()) {
        props.setApp?.(await artifactClient.get(item.id));
        props.setSelectedVersion?.(undefined);
      }
    });
  };

  const versions = (item: ArtifactSummary) =>
    prompts.dialog<void>(
      (close) => {
        const [page, setPage] = createSignal(1);
        const [entries] = createResource(page, (p) => artifactClient.versions(item.id, p));
        return (
          <div class="assistant-version-list">
            <NoticeCard tone="info" title={t().versions} detail={t().versionsHelp} />
            <Show when={!entries.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
              <Show when={!entries.error} fallback={<Placeholder state="error" title={t().loadFailed} />}>
                <Show
                  when={entries()?.items.length}
                  fallback={
                    <Placeholder
                      title={t().noVersions}
                      action={
                        <Button
                          onClick={() => {
                            close();
                            void publish(item);
                          }}
                        >
                          {t().publish}
                        </Button>
                      }
                    />
                  }
                >
                  <div class="assistant-version-rows">
                    <For each={entries()?.items}>
                      {(entry) => (
                        <div class="assistant-version-entry">
                          <strong>v{entry.version}</strong>
                          <p>{entry.note}</p>
                          <div class="assistant-version-entry__actions">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                props.setSelectedVersion?.(entry.version);
                                close();
                              }}
                            >
                              {t().start}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                close();
                                void action(async () => {
                                  const draft = await artifactClient.get(item.id);
                                  const restored = await artifactClient.restore(item.id, entry.version, draft.revision);
                                  props.setApp?.(restored);
                                  props.setSelectedVersion?.(restored.publishedVersion ?? undefined);
                                });
                              }}
                            >
                              {t().restore}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={page() > 1 || entries()?.hasNext}>
                  <div class="assistant-studio-card__footer">
                    <Button disabled={page() === 1} onClick={() => setPage((p) => p - 1)}>
                      {t().back}
                    </Button>
                    <Button disabled={!entries()?.hasNext} onClick={() => setPage((p) => p + 1)}>
                      {t().next}
                    </Button>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        );
      },
      { title: t().versions, size: "medium" },
    );
  const menu = (item: ArtifactSummary) => [
    { label: t().openApp, icon: "ti ti-maximize", action: () => openRunner(item) },
    ...(item.publishedRevision
      ? [
          {
            label: t().copyAppLink,
            icon: "ti ti-link",
            action: () => action(() => navigator.clipboard.writeText(new URL(runnerHref(item.id), location.origin).href)),
          },
        ]
      : []),
    ...(props.app?.() && props.view && props.view !== "app"
      ? [{ label: a().app, icon: "ti ti-app-window", action: () => open(item.id) }]
      : []),
    ...(item.permission === "admin"
      ? [
          { label: a().assistantEdit, icon: "ti ti-pencil", action: () => edit(item.id) },
          { label: t().share, icon: "ti ti-users", action: () => share(item) },
          {
            label: item.publishedRevision ? t().publishUpdate : t().publish,
            icon: "ti ti-upload",
            disabled: item.publishedRevision === item.revision,
            action: () => publish(item),
          },
          ...(item.publishedRevision
            ? [
                {
                  label: t().unpublish,
                  icon: "ti ti-eye-off",
                  action: () =>
                    action(async () => {
                      await artifactClient.unpublish(item.id);
                      if (props.app?.()?.id === item.id) {
                        props.setApp?.(await artifactClient.get(item.id));
                        props.setSelectedVersion?.(undefined);
                      }
                    }),
                },
              ]
            : []),
        ]
      : []),
    ...(item.publishedRevision
      ? [
          {
            label: t().fork,
            icon: "ti ti-copy",
            action: () =>
              action(async () => {
                const copy = await artifactClient.fork(item.id);
                navigateTo((await artifactClient.editChat(copy.id)).href);
              }),
          },
        ]
      : []),
    {
      sectionLabel: a().advanced,
      items: [
        { label: "Secrets", icon: "ti ti-key", action: () => openSecretsDialog({ resourceId: item.id }) },
        ...(item.permission === "admin"
          ? [
              { label: a().manualEdit, icon: "ti ti-code", action: () => navigateTo(`/app/assistant/apps/${item.id}/edit`) },
              { label: a().sql, icon: "ti ti-database", action: () => navigateTo(`/app/assistant/apps/${item.id}/database`) },
            ]
          : []),
        { label: a().local, icon: "ti ti-device-desktop", action: () => openDataDialog(item.id, props.userId, "local", a().local) },
        ...(item.permission === "admin"
          ? [
              { label: a().shared, icon: "ti ti-cloud", action: () => openDataDialog(item.id, props.userId, "shared", a().shared) },
              { label: a().database, icon: "ti ti-database-cog", action: () => openDatabaseDialog(item.id, a().database) },
            ]
          : []),
      ],
    },
    ...(item.permission === "admin"
      ? [
          {
            sectionLabel: a().dangerZone,
            items: [
              {
                label: t().remove,
                icon: "ti ti-trash",
                variant: "danger" as const,
                action: async () => {
                  if (await prompts.confirm(t().removeConfirm, { title: t().remove, variant: "danger" }))
                    await action(async () => {
                      await artifactClient.remove(item.id);
                      if (props.app?.()?.id === item.id) navigateTo("/app/assistant?studio=1");
                    });
                },
              },
            ],
          },
        ]
      : []),
  ];
  return { menu, action, busy, error, publish, versions, openRunner };
}
