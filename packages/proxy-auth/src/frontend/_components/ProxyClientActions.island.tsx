import { refreshCurrentPath } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, Dropdown, prompts, Tag, TextInput, toast, useLocale } from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@valentinkolb/cloud/account/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ProxyAuthAllowedGroup, ProxyAuthClient, UpdateProxyAuthClient } from "@/contracts";
import { proxyAuthMessages } from "../messages";

type Props = {
  client: ProxyAuthClient;
};

const ProxyClientActions = (props: Props) => {
  const locale = useLocale();
  const t = () => proxyAuthMessages.resolve([locale()]).t;
  const { client } = props;

  const updateMutation = mutations.create<{ message: string }, UpdateProxyAuthClient>({
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
      toast.success(t().updated);
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
      toast.success(t().deleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleEdit = async () => {
    const result = await prompts.dialog<UpdateProxyAuthClient | null>(
      (close) => {
        const [description, setDescription] = createSignal(client.description ?? "");
        const [groups, setGroups] = createSignal<ProxyAuthAllowedGroup[]>([...client.allowedGroups]);

        const handleGroupSelect = (r: EntitySearchPrincipal) => {
          if (r.type === "group" && !groups().some((group) => group.id === r.groupId)) {
            setGroups([...groups(), { id: r.groupId, name: r.name, provider: r.provider }]);
          }
        };

        const handleSubmit = () => {
          if (groups().length === 0) {
            prompts.error(t().groupRequired);
            return;
          }
          close({
            description: description().trim() || null,
            allowedGroupIds: groups().map((group) => group.id),
          });
        };

        return (
          <div class="flex flex-col gap-4">
            <NoticeCard tone="info" icon={false}>
              {t().clientId}: <code class="bg-zinc-50 dark:bg-zinc-800 px-1 rounded">{client.clientId}</code>
            </NoticeCard>

            <TextInput
              label={t().description}
              placeholder={t().optionalDescription}
              icon="ti ti-file-description"
              value={description}
              onValueChange={setDescription}
            />

            <div class="flex flex-col gap-1">
              <p class="text-xs text-secondary">{t().allowedGroups} *</p>
              <Show when={groups().length > 0}>
                <div class="flex flex-wrap gap-1 mb-1">
                  <For each={groups()}>
                    {(group) => (
                      <Tag
                        icon="ti ti-users-group"
                        size="sm"
                        onRemove={() => setGroups(groups().filter((candidate) => candidate.id !== group.id))}
                        removeLabel={t().removeGroup({ name: group.name })}
                      >
                        {group.name}
                      </Tag>
                    )}
                  </For>
                </div>
              </Show>
              <EntitySearch
                includeGroups
                excludeGroupIds={groups().map((group) => group.id)}
                onSelect={handleGroupSelect}
                placeholder={t().searchGroups}
              />
            </div>

            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => close(null)}>
                {t().cancel}
              </Button>
              <Button size="sm" onClick={handleSubmit}>
                <i class="ti ti-check" />
                {t().save}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().editClient({ name: client.name }), icon: "ti ti-pencil" },
    );

    if (result) {
      await updateMutation.mutate(result);
    }
  };

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteConfirm({ name: client.name }), {
      title: t().deleteClient,
      icon: "ti ti-trash",
      confirmText: t().delete,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await deleteMutation.mutate();
    }
  };

  const handleCopyVerifyUrl = async () => {
    const baseUrl = window.location.origin;
    try {
      await clipboard.copy(`${baseUrl}/proxy-auth/verify/${client.clientId}`);
      toast.success(t().verifyUrlCopied);
    } catch {
      toast.error(t().verifyUrlCopyFailed);
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
              label: t().copyVerifyUrl,
              action: handleCopyVerifyUrl,
            },
            {
              icon: "ti ti-pencil",
              label: t().edit,
              action: handleEdit,
            },
          ],
        },
        {
          items: [
            {
              icon: "ti ti-trash",
              label: t().delete,
              action: handleDelete,
              variant: "danger",
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().clientActions} size="sm">
        <i class="ti ti-dots-vertical" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default ProxyClientActions;
