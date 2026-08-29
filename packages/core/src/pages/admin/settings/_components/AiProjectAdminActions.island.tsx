import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, Dropdown, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AiProjectAccess } from "@valentinkolb/cloud/ai";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { Show } from "solid-js";
import { settingsMessages } from "./messages";

type Props = {
  projectId: string;
  projectName: string;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const PermissionDialogBody = (props: Props) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const entries = query.create({
    source: () => props.projectId,
    load: async (projectId, { abortSignal }): Promise<AiProjectAccess[]> => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].access.$get(
        { param: { projectId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, t().loadProjectPermissionsFailed));
      return (await response.json()).access;
    },
  });

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageProjectAccess}</p>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title={t().loadingProjectAccess} />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title={t().loadProjectAccessFailed}
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
                const response = await coreClient.admin.core["ai-projects"][":projectId"].access.$post({
                  param: { projectId: props.projectId },
                  json: { principal, permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().grantProjectAccessFailed));
                return (await response.json()).access;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await coreClient.admin.core["ai-projects"][":projectId"].access[":accessId"].$patch({
                  param: { projectId: props.projectId, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readError(response, t().updateProjectAccessFailed));
              }}
              revokeAccess={async (accessId) => {
                const response = await coreClient.admin.core["ai-projects"][":projectId"].access[":accessId"].$delete({
                  param: { projectId: props.projectId, accessId },
                });
                if (!response.ok) throw new Error(await readError(response, t().revokeProjectAccessFailed));
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
    title: props.projectName,
    icon: "ti ti-shield",
  });
  refreshCurrentPath();
};

export default function AiProjectAdminActions(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].$delete({ param: { projectId: props.projectId } });
      if (!response.ok) throw new Error(await readError(response, t().deleteProjectFailed));
    },
    onSuccess: () => {
      toast.success(t().projectDeleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().deleteProjectFailed),
  });

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteProjectConfirm({ name: props.projectName }), {
      title: t().deleteProject,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) remove.mutate();
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-shield",
              label: t().permissions,
              action: () => void openPermissionDialog(props),
            },
            {
              icon: "ti ti-trash",
              label: t().deleteProject,
              variant: "danger",
              action: () => void handleDelete(),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.projectName })} size="xs" tooltip={t().projectActions}>
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
