import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, Dropdown, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AiSkillAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { Show } from "solid-js";
import { settingsMessages } from "./messages";

type Props = {
  skillId: string;
  skillName: string;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
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

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">{t().manageSkillAccess}</p>
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
                  json: { principal, permission },
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
    const confirmed = await prompts.confirm(t().deleteSkillConfirm({ name: props.skillName }), {
      title: t().deleteSkill,
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
