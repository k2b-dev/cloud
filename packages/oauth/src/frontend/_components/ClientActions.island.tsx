import { refreshCurrentPath } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { CopyButton, Dropdown, dialogCore, panelDialogWideOptions, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { OAuthClient, UpdateOAuthClient } from "@/contracts";
import OAuthClientDialog from "./OAuthClientDialog";
import { oauthMessages } from "../messages";

type ClientActionsProps = {
  client: OAuthClient;
};

const ClientActions = (props: ClientActionsProps) => {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const { client } = props;

  const updateMutation = mutations.create<{ message: string }, UpdateOAuthClient>({
    mutation: async (data) => {
      const res = await apiClient[":id"].$put({
        param: { id: client.id },
        json: data,
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(t().failedUpdate);
      }
      return result as { message: string };
    },
    onSuccess: () => {
      toast.success(t().clientUpdated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const deleteMutation = mutations.create<{ message: string }, void>({
    mutation: async () => {
      const res = await apiClient[":id"].$delete({
        param: { id: client.id },
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(t().failedDelete);
      }
      return result as { message: string };
    },
    onSuccess: () => {
      toast.success(t().clientDeleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const regenerateSecretMutation = mutations.create<{ clientSecret: string }, void>({
    mutation: async () => {
      const res = await apiClient[":id"]["regenerate-secret"].$post({
        param: { id: client.id },
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(t().failedRegenerate);
      }
      return result as { clientSecret: string };
    },
    onSuccess: async (data) => {
      await prompts.alert(
        <div class="space-y-3">
          <div>
            <div class="text-xs text-dimmed mb-1">{t().newClientSecret}</div>
            <div class="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2">
              <code class="text-sm flex-1 break-all">{data.clientSecret}</code>
              <CopyButton text={data.clientSecret} />
            </div>
          </div>
          <div class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <i class="ti ti-alert-triangle" />
            {t().saveSecretNow}
          </div>
        </div>,
        {
          title: t().secretRegenerated,
          icon: "ti ti-key",
        },
      );
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleEdit = async () => {
    void dialogCore.open<void>(
      (close) => (
        <OAuthClientDialog
          mode="edit"
          client={client}
          close={close}
          loading={updateMutation.loading}
          onSubmit={async (data) => {
            await updateMutation.mutate(data);
            if (!updateMutation.error()) close();
          }}
        />
      ),
      panelDialogWideOptions,
    );
  };

  const handleDelete = async () => {
    const isDynamic = client.registrationKind === "dynamic";
    const confirmed = await prompts.confirm(
      t().confirmRemove({ action: isDynamic ? t().revokeAction : t().deleteAction, name: client.name }),
      {
        title: isDynamic ? t().revokeClient : t().deleteClient,
        icon: "ti ti-trash",
        confirmText: isDynamic ? t().revokeAction : t().deleteAction,
        cancelText: t().cancel,
        variant: "danger",
      },
    );
    if (confirmed) {
      await deleteMutation.mutate();
    }
  };

  const handleRegenerateSecret = async () => {
    const confirmed = await prompts.confirm(t().regenerateWarning, {
      title: t().regenerateSecret,
      icon: "ti ti-key",
      confirmText: t().regenerate,
      cancelText: t().cancel,
    });
    if (confirmed) {
      await regenerateSecretMutation.mutate();
    }
  };

  const handleCopyClientId = async () => {
    try {
      await clipboard.copy(client.clientId);
      toast.success(t().copiedClientId);
    } catch {
      toast.error(t().copyClientIdFailed);
    }
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="12rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-copy",
              label: t().copyClientId,
              action: handleCopyClientId,
            },
            ...(client.registrationKind === "managed"
              ? [
                  {
                    icon: "ti ti-pencil",
                    label: t().edit,
                    action: handleEdit,
                  },
                ]
              : []),
            ...(client.registrationKind === "managed" && !client.isPublic
              ? [
                  {
                    icon: "ti ti-key",
                    label: t().regenerate,
                    action: handleRegenerateSecret,
                  },
                ]
              : []),
          ],
        },
        ...(client.registrationKind !== "first_party"
          ? [
              {
                items: [
                  {
                    icon: "ti ti-trash",
                    label: client.registrationKind === "dynamic" ? t().revokeAction : t().deleteAction,
                    action: handleDelete,
                    variant: "danger" as const,
                  },
                ],
              },
            ]
          : []),
      ]}
    >
      <Dropdown.Trigger iconOnly size="xs" label={t().oauthClientActions} tooltip={t().oauthClientActions}>
        <i class="ti ti-dots-vertical text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default ClientActions;
