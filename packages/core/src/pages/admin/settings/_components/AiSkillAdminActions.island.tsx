import { openAccessDialog } from "@k2b/cloud/access/ui";
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
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { findAiServiceAccount } from "./ai-service-account-lookup";
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

type SettingsMessages = ReturnType<typeof settingsMessages.resolve>["t"];
type ProjectContext = { state: "loading" } | { state: "failed" } | { state: "ready"; names: (string | null)[] };

/** The projects that include the Skill: context next to the direct access, loaded on its own with a retry. */
const SkillProjects = (props: { context: () => ProjectContext; retry: () => void; t: SettingsMessages }) => (
  <Switch>
    <Match when={props.context().state === "loading"}>
      <InlineGuidance loading>{props.t.loadingSkillProjects}</InlineGuidance>
    </Match>
    <Match when={props.context().state === "failed"}>
      <InlineGuidance tone="warning" icon="ti ti-alert-triangle">
        {props.t.skillProjectsUnavailable}{" "}
        <Button size="xs" variant="text" onClick={() => props.retry()}>
          {props.t.retry}
        </Button>
      </InlineGuidance>
    </Match>
    <Match
      when={(() => {
        const context = props.context();
        return context.state === "ready" && context.names.length > 0 ? context.names : undefined;
      })()}
    >
      {(names) => (
        <NoticeCard tone="info" title={props.t.skillProjectAccessTitle} detail={props.t.skillProjectAccessHelp}>
          <ul class="flex flex-col gap-1">
            <For each={names()}>{(name) => <li>{name ?? props.t.skillProjectUnavailable}</li>}</For>
          </ul>
        </NoticeCard>
      )}
    </Match>
  </Switch>
);

const openPermissionDialog = async (props: Props, locale: string, signal: AbortSignal) => {
  const t = settingsMessages.resolve([locale]).t;
  const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$get(
    { param: { skillId: props.skillId } },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(await readError(response, t.loadSkillPermissionsFailed));
  const initialEntries: AiSkillAccess[] = (await response.json()).access;
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return;
  // The projects are context; a slow or failed answer never holds up editing the direct access.
  const [projects, setProjects] = createSignal<ProjectContext>({ state: "loading" });
  const loadProjects = () => {
    setProjects({ state: "loading" });
    coreClient.admin.core["ai-skills"][":skillId"].projects
      .$get({ param: { skillId: props.skillId } }, { init: { signal } })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(t.skillProjectsUnavailable);
        const names = (await answer.json()).projects.map((project) => project.name);
        if (!signal.aborted) setProjects({ state: "ready", names });
      })
      .catch(() => {
        if (!signal.aborted) setProjects({ state: "failed" });
      });
  };
  loadProjects();
  // Set by every saved change, also when a later one fails and the person discards the rest.
  let wrote = false;
  await openAccessDialog({
    resourceName: props.skillName,
    subtitle: t.skillAccessSubtitle,
    initialEntries,
    allowPublic: false,
    findServiceAccount: (handle, signal) => findAiServiceAccount({ type: "core.ai.skill", id: props.skillId }, handle, signal),
    signal,
    extraSections: <SkillProjects context={projects} retry={loadProjects} t={t} />,
    grantAccess: async (principal, permission) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$post({
        param: { skillId: props.skillId },
        json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
      });
      if (!response.ok) throw new Error(await readError(response, t.grantSkillAccessFailed));
      wrote = true;
      return (await response.json()).access;
    },
    updateAccess: async (accessId, permission) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$patch({
        param: { skillId: props.skillId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readError(response, t.updateSkillAccessFailed));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$delete({
        param: { skillId: props.skillId, accessId },
      });
      if (!response.ok) throw new Error(await readError(response, t.revokeSkillAccessFailed));
      wrote = true;
    },
  });
  // After navigation the page is another one; refreshing it would cancel where the person went.
  if (wrote && !signal.aborted) refreshCurrentPath();
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
                          <Show when={!file.replaced} fallback={<p class="text-xs text-dimmed">{t().diffReplaced}</p>}>
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
                          </Show>
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
  const loading = new AbortController();
  onCleanup(() => loading.abort());
  // Loading the stored entries shows on the trigger; a failure says why instead of opening an empty dialog.
  const permissions = mutations.create<void, void>({
    mutation: () => openPermissionDialog(props, locale(), loading.signal),
    onError: (error) => {
      if (!loading.signal.aborted) void prompts.error(error.message);
    },
  });
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
              action: () => void (permissions.loading() || permissions.mutate()),
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
        <i class={permissions.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"} />
        <span class="sr-only" role="status">
          {permissions.loading() ? t().loadingSkillAccess : ""}
        </span>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
