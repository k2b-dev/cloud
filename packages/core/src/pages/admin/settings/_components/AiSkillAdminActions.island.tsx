import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, Dropdown, Placeholder, prompts, toast } from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AiSkillAccess } from "@valentinkolb/cloud/ai";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { Show } from "solid-js";

type Props = {
  skillId: string;
  skillName: string;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const PermissionDialogBody = (props: Props) => {
  const entries = query.create({
    source: () => props.skillId,
    load: async (skillId, { abortSignal }): Promise<AiSkillAccess[]> => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].access.$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, "Failed to load Skill permissions."));
      return (await response.json()).access;
    },
  });

  return (
    <div class="flex w-full max-w-full flex-col gap-2">
      <p class="text-xs text-dimmed">
        Manage direct Skill access. At least one administrator must remain once the Skill has been recovered.
      </p>
      <Show when={!entries.loading()} fallback={<Placeholder state="loading" title="Loading Skill access" />}>
        <Show
          when={entries.data()}
          keyed
          fallback={
            <Placeholder
              state="error"
              title="Could not load Skill access"
              description={entries.error()?.message}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void entries.refresh()}>
                  Retry
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
                if (!response.ok) throw new Error(await readError(response, "Failed to grant Skill access."));
                return (await response.json()).access;
              }}
              updateAccess={async (accessId, permission) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$patch({
                  param: { skillId: props.skillId, accessId },
                  json: { permission },
                });
                if (!response.ok) throw new Error(await readError(response, "Failed to update Skill access."));
              }}
              revokeAccess={async (accessId) => {
                const response = await coreClient.admin.core["ai-skills"][":skillId"].access[":accessId"].$delete({
                  param: { skillId: props.skillId, accessId },
                });
                if (!response.ok) throw new Error(await readError(response, "Failed to revoke Skill access."));
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
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"].$delete({ param: { skillId: props.skillId } });
      if (!response.ok) throw new Error(await readError(response, "Failed to delete Skill."));
    },
    onSuccess: () => {
      toast.success("Skill deleted.");
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : "Failed to delete Skill."),
  });

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(`Delete "${props.skillName}"? This permanently removes its instructions and extra info.`, {
      title: "Delete Skill",
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: "Delete",
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
              label: "Permissions",
              action: () => void openPermissionDialog(props),
            },
            {
              icon: "ti ti-trash",
              label: "Delete Skill",
              variant: "danger",
              action: () => void handleDelete(),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={`Actions for ${props.skillName}`} size="xs" tooltip="Skill actions">
        <i class="ti ti-settings text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
