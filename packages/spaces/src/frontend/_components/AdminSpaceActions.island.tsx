import { openAccessDialog } from "@k2b/cloud/access/ui";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { AccessEntry } from "@/contracts";
import { useSpaceMessages } from "../[id]/messages";

type AdminSpaceActionsProps = {
  spaceId: string;
  spaceName: string;
};

const readErrorMessage = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const data = (await response.json()) as { message?: string };
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  } catch {
    // ignore parse errors and use fallback
  }
  return fallback;
};

const openPermissionDialog = async (props: AdminSpaceActionsProps, m: ReturnType<typeof useSpaceMessages>) => {
  const response = await apiClient.admin[":id"].access.$get({ param: { id: props.spaceId } });
  if (!response.ok) throw new Error(await readErrorMessage(response, m.loadPermissionsFailed));
  await openAccessDialog({
    resourceName: props.spaceName,
    subtitle: m.accessDialogSubtitle,
    initialEntries: await response.json(),
    grantAccess: async (principal, permission) => {
      const response = await apiClient.admin[":id"].access.$post({
        param: { id: props.spaceId },
        json: { principal, permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.adminGrantAccessFailed));
      return (await response.json()) as AccessEntry;
    },
    updateAccess: async (accessId, permission) => {
      const response = await apiClient.admin[":id"].access[":accessId"].$patch({
        param: { id: props.spaceId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.adminUpdateAccessFailed));
    },
    revokeAccess: async (accessId) => {
      const response = await apiClient.admin[":id"].access[":accessId"].$delete({
        param: { id: props.spaceId, accessId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.adminRevokeAccessFailed));
    },
  });
};

const AdminSpaceActions = (props: AdminSpaceActionsProps) => {
  const m = useSpaceMessages();
  const deleteMutation = mutations.create<void, { spaceId: string }>({
    mutation: async ({ spaceId }) => {
      const response = await apiClient.admin[":id"].$delete({
        param: { id: spaceId },
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, m.adminDeleteFailed));
      }
    },
    onSuccess: () => {
      toast.success(m.spaceDeleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });
  // Loading the stored entries shows on the trigger; a failure says why instead of opening an empty dialog.
  const permissionsMutation = mutations.create<void, void>({
    mutation: () => openPermissionDialog(props, m),
    onError: (err) => prompts.error(err.message),
  });
  let deletePromptPending = false;
  const deleteSpace = async () => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await prompts.confirm(m.adminDeleteConfirm({ name: props.spaceName }), {
        title: m.deleteSpace,
        icon: "ti ti-trash",
        confirmText: m.delete,
        variant: "danger",
      });
      if (confirmed) void deleteMutation.mutate({ spaceId: props.spaceId });
    } finally {
      deletePromptPending = false;
    }
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
              label: m.permissions,
              action: () => void (permissionsMutation.loading() || permissionsMutation.mutate()),
            },
          ],
        },
        {
          items: [
            {
              icon: "ti ti-trash",
              label: m.delete,
              action: () => void deleteSpace(),
              variant: "danger",
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={m.actionsForSpace({ name: props.spaceName })} size="sm" class="h-7 w-7" tooltip={m.spaceActions}>
        <i
          class={
            deleteMutation.loading() || permissionsMutation.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"
          }
        />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminSpaceActions;
