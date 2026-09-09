import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, prompts, Tag, TextInput, useLocale } from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@k2b/cloud/account/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { CreateProxyAuthClient, ProxyAuthAllowedGroup, ProxyAuthClient } from "@/contracts";
import { proxyAuthMessages } from "../messages";

const CreateProxyClient = () => {
  const locale = useLocale();
  const t = () => proxyAuthMessages.resolve([locale()]).t;
  const mutation = mutations.create<ProxyAuthClient, CreateProxyAuthClient>({
    mutation: async (data) => {
      const res = await apiClient.index.$post({ json: data });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(t().failedCreate);
      }
      return result as ProxyAuthClient;
    },
    onSuccess: async (data) => {
      const verifyUrl = `${window.location.origin}/proxy-auth/verify/${data.clientId}`;

      await prompts.alert(
        <div class="space-y-4">
          <div>
            <div class="text-xs text-dimmed mb-1">{t().verifyUrl}</div>
            <div class="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2">
              <code class="text-sm flex-1 break-all">{verifyUrl}</code>
              <CopyButton text={verifyUrl} />
            </div>
          </div>
          <div class="text-xs text-dimmed">{t().copyLater}</div>
        </div>,
        { title: t().clientCreated, icon: "ti ti-check" },
      );
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleCreate = async () => {
    const result = await prompts.dialog<CreateProxyAuthClient | null>(
      (close) => {
        const [name, setName] = createSignal("");
        const [description, setDescription] = createSignal("");
        const [groups, setGroups] = createSignal<ProxyAuthAllowedGroup[]>([]);

        const handleGroupSelect = (r: EntitySearchPrincipal) => {
          if (r.type === "group" && !groups().some((group) => group.id === r.groupId)) {
            setGroups([...groups(), { id: r.groupId, name: r.name, provider: r.provider }]);
          }
        };

        const handleSubmit = () => {
          if (!name().trim()) {
            prompts.error(t().nameRequired);
            return;
          }
          if (groups().length === 0) {
            prompts.error(t().groupRequired);
            return;
          }
          close({
            name: name().trim(),
            description: description().trim() || undefined,
            allowedGroupIds: groups().map((group) => group.id),
          });
        };

        return (
          <div class="flex flex-col gap-4">
            <TextInput label={t().name} placeholder={t().clientName} icon="ti ti-tag" value={name} onValueChange={setName} required />

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
                <i class="ti ti-plus" />
                {t().create}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().newProxyClient, icon: "ti ti-plus" },
    );

    if (result) {
      await mutation.mutate(result);
    }
  };

  return (
    <Button size="sm" onClick={handleCreate}>
      <i class="ti ti-plus" />
      {t().newClient}
    </Button>
  );
};

export default CreateProxyClient;
