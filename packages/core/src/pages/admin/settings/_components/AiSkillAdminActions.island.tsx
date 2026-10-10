import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AiSkillAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { AuthenticatedPrincipalSchema } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  Dropdown,
  dialogCore,
  InlineGuidance,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWideOptions,
  prompts,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { settingsMessages } from "./messages";
import { diffSkillVersions } from "./skill-diff";

type Props = {
  skillId: string;
  skillName: string;
  revision: number;
  /** Set for a Skill an app ships; its name is already in the request locale. */
  source: { appName: string; status: "current" | "modified" | "update_available" } | null;
};

const readError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const PermissionDialogBody = (props: Props) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }): Promise<AiSkillAccess[]> => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().loadSkillPermissionsFailed));
      return (await response.json()).access;
    },
  });

  const projects = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].projects.$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().loadSkillPermissionsFailed));
      return (await response.json()).projects;
    },
  });

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageSkillAccess}</p>
      <Show when={projects.loading()}>
        <InlineGuidance loading>{t().loadingSkillAccess}</InlineGuidance>
      </Show>
      <Show when={projects.error()}>
        <InlineGuidance tone="danger">
          {t().loadSkillAccessFailed}
          <Button size="sm" variant="ghost" onClick={() => void projects.refresh()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={projects.data()?.length}>
        <NoticeCard tone="info" title={t().skillProjectAccessTitle} detail={t().skillProjectAccessHelp}>
          <ul class="flex flex-col gap-1">
            <For each={projects.data()}>{(project) => <li>{project.name ?? t().skillProjectUnavailable}</li>}</For>
          </ul>
        </NoticeCard>
      </Show>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loadingSkillAccess} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title={t().loadSkillAccessFailed}
              description={entries.error()?.message}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void entries.refresh()}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          {(currentEntries) => (
            <PermissionEditor
              initialEntries={currentEntries}
              canEdit
              allowPublic={false}
              allowServiceAccounts
              grantAccess={async (principal, permission) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$post({
                  param: { skillId: props.skillId },
                  json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().grantSkillAccessFailed));
                return (await response.json()).access;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$patch({
                  param: { skillId: props.skillId, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().updateSkillAccessFailed));
              }}
              revokeAccess={async (accessId) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$delete({
                  param: { skillId: props.skillId, accessId },
                });
                if (!response.ok) throw new Error(await readError(response, t().revokeSkillAccessFailed));
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  );
};

const openPermissionDialog = async (props: Props) => {
  await prompts.dialog<void>(() => <PermissionDialogBody {...props} />, {
    title: props.skillName,
    icon: "ti ti-shield",
  });
  refreshCurrentPath();
};

const AppVersionDialog = (props: Props & { appName: string; close: () => void }) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const version = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"]["app-version"].$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().appVersionFailed));
      return response.json();
    },
  });
  const files = createMemo(() => {
    const data = version.data();
    return data?.app ? diffSkillVersions(data.current, data.app) : [];
  });
  const reset = mutations.create<void, string>({
    mutation: async (appVersion) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].reset.$post({
        param: { skillId: props.skillId },
        json: { expectedRevision: props.revision, expectedAppVersion: appVersion, confirmed: true },
      });
      if (!response.ok) throw new Error(await readError(response, t().skillResetFailed));
    },
    onSuccess: () => {
      toast.success(t().skillResetDone);
      props.close();
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().skillResetFailed),
  });
  const confirmReset = async () => {
    const appVersion = version.data()?.appVersion;
    if (!appVersion) return;
    const confirmed = await prompts.confirm(t().resetToAppConfirm({ name: props.skillName, app: props.appName }), {
      title: t().resetToApp,
      icon: "ti ti-restore",
      variant: "danger",
      confirmText: t().resetToApp,
    });
    if (confirmed) reset.mutate(appVersion);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.skillName}
        subtitle={t().compareWithAppSubtitle({ app: props.appName })}
        icon="ti ti-git-compare"
        close={props.close}
        closeDisabled={reset.loading()}
      />
      <PanelDialog.Body scrollPreserveKey="admin-ai-skill-app-version">
        <Show when={!version.loading()} fallback={<Placeholder state="loading" title={t().appVersionLoading} />}>
          <Show
            when={version.data()}
            fallback={
              <Placeholder
                state="error"
                title={t().appVersionFailed}
                description={version.error()?.message}
                action={
                  <Button type="button" variant="secondary" size="sm" onClick={() => void version.refresh()}>
                    {t().retry}
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <Show when={data().app} fallback={<Placeholder state="empty" icon="ti ti-plug-off" title={t().appVersionMissing} />}>
                <Show when={files().length > 0} fallback={<Placeholder state="empty" icon="ti ti-check" title={t().appVersionMatches} />}>
                  <div class="flex flex-col gap-5">
                    <p class="text-xs text-dimmed">{t().diffLegend}</p>
                    <For each={files()}>
                      {(file) => (
                        <section class="flex min-w-0 flex-col gap-1" aria-label={file.path}>
                          <h3 class="flex items-baseline gap-2 text-xs font-medium text-primary">
                            <span class="truncate font-mono">{file.path}</span>
                            <span class="shrink-0 tabular-nums text-green-700 dark:text-green-300">+{file.added}</span>
                            <span class="shrink-0 tabular-nums text-red-700 dark:text-red-300">−{file.removed}</span>
                          </h3>
                          <div class="overflow-x-auto rounded-md font-mono text-xs leading-5">
                            <For each={file.rows}>
                              {(row) =>
                                row.kind === "gap" ? (
                                  <div class="px-2 py-0.5 text-dimmed">{t().unchangedLines({ count: row.count })}</div>
                                ) : (
                                  <div
                                    class={`grid grid-cols-[1.5rem_minmax(0,1fr)] ${
                                      row.kind === "added"
                                        ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                                        : row.kind === "removed"
                                          ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                                          : "text-secondary"
                                    }`}
                                  >
                                    <span class="select-none text-center text-dimmed" aria-hidden="true">
                                      {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
                                    </span>
                                    <span class="whitespace-pre-wrap break-words pr-2">{row.value || " "}</span>
                                  </div>
                                )
                              }
                            </For>
                          </div>
                        </section>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            )}
          </Show>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="ml-auto flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={props.close} disabled={reset.loading()}>
            {t().close}
          </Button>
          <Show when={props.source?.status !== "current" && version.data()?.app}>
            <Button type="button" variant="danger" onClick={() => void confirmReset()} loading={reset.loading()}>
              {t().resetToApp}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
};

export default function AiSkillAdminActions(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].$delete({ param: { skillId: props.skillId } });
      if (!response.ok) throw new Error(await readError(response, t().deleteSkillFailed));
    },
    onSuccess: () => {
      toast.success(t().skillDeleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().deleteSkillFailed),
  });

  const handleDelete = async () => {
    const message = props.source
      ? t().deleteAppSkillConfirm({ name: props.skillName, app: props.source.appName })
      : t().deleteSkillConfirm({ name: props.skillName });
    const confirmed = await prompts.confirm(message, {
      title: t().deleteSkill,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) remove.mutate();
  };

  const openAppVersion = () => {
    const source = props.source;
    if (!source) return;
    return dialogCore.open<void>(
      (close) => <AppVersionDialog {...props} appName={source.appName} close={() => close()} />,
      panelDialogWideOptions,
    );
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="15rem"
      items={[
        {
          items: [
            ...(props.source
              ? [
                  {
                    icon: "ti ti-git-compare",
                    label: t().compareWithApp,
                    action: () => void openAppVersion(),
                  },
                ]
              : []),
            {
              icon: "ti ti-shield",
              label: t().permissions,
              action: () => void openPermissionDialog(props),
            },
            {
              icon: "ti ti-trash",
              label: t().deleteSkill,
              variant: "danger",
              action: () => void handleDelete(),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.skillName })} size="xs" tooltip={t().skillActions}>
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
