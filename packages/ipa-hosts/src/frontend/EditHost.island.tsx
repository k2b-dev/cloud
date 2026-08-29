import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations, timed as timing } from "@k2b/stdlib/solid";
import { Button, Dropdown, IconButton, Placeholder, prompts, TextInput, Tooltip, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Index, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { normalizeMacAddress } from "@/contracts";
import { hostMessages } from "./messages";

const MAC_ADDRESS_REGEX = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

type HostActionsProps = {
  fqdn: string;
  description: string | null;
  locality: string | null;
  location: string | null;
  macAddress: string[];
  memberofHostgroup: string[];
  currentGroup?: string;
};

type EditHostPayload = {
  description?: string;
  locality?: string;
  location?: string;
  macAddress?: string[];
};

type EditableMacAddress = {
  value: string;
};

const MacAddressRow = (props: {
  index: number;
  value: () => string;
  error: () => string | undefined;
  onInput: (value: string) => void;
  onRemove: () => void;
}) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  return (
    <div class="flex items-start gap-2">
      <div class="flex-1">
        <TextInput
          label={t().macAddress({ number: props.index + 1 })}
          placeholder="AA:BB:CC:DD:EE:FF"
          icon="ti ti-address-book"
          activeIcon="ti ti-address-book"
          value={props.value}
          onValueChange={props.onInput}
          error={props.error}
        />
      </div>
      <Tooltip.Anchor content={t().removeMac({ number: props.index + 1 })} class="shrink-0">
        <IconButton size="md" variant="danger" label={t().removeMac({ number: props.index + 1 })} onClick={props.onRemove}>
          <i class="ti ti-trash" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
    </div>
  );
};

const HostActions = (props: HostActionsProps) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const editMutation = mutations.create<void, EditHostPayload>({
    mutation: async (vars) => {
      const res = await apiClient[":fqdn"].$patch({ param: { fqdn: props.fqdn }, json: vars });
      if (!res.ok) {
        throw new Error(t().failedUpdateHost);
      }
    },
    onSuccess: () => {
      toast.success(t().hostUpdated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });
  const deleteMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient[":fqdn"].$delete({ param: { fqdn: props.fqdn } });
      if (!res.ok) {
        throw new Error(t().failedDeleteHost);
      }
    },
    onSuccess: () => {
      toast.success(t().hostDeleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });
  const addToGroupMutation = mutations.create<void, string>({
    mutation: async (hostgroup) => {
      const res = await apiClient[":fqdn"].hostgroups.$post({ param: { fqdn: props.fqdn }, json: { hostgroup } });
      if (!res.ok) {
        throw new Error(t().failedAddGroup);
      }
    },
    onSuccess: () => {
      toast.success(t().hostAdded);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });
  const removeFromGroupMutation = mutations.create<void, string>({
    mutation: async (hostgroup) => {
      const res = await apiClient[":fqdn"].hostgroups.$delete({ param: { fqdn: props.fqdn }, json: { hostgroup } });
      if (!res.ok) {
        throw new Error(t().failedRemoveGroup);
      }
    },
    onSuccess: () => {
      toast.success(t().hostRemoved);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });
  const handleRemoveFromGroup = async (groupName: string) => {
    const confirmed = await prompts.confirm(t().removeFromGroupConfirm({ host: props.fqdn, group: groupName }), {
      title: t().removeFromGroup,
      icon: "ti ti-folder-minus",
      confirmText: t().remove,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await removeFromGroupMutation.mutate(groupName);
    }
  };
  const handleEdit = async () => {
    prompts.dialog(
      (close) => (
        <EditHostDialog
          fqdn={props.fqdn}
          description={props.description}
          locality={props.locality}
          location={props.location}
          macAddress={props.macAddress}
          saving={editMutation.loading()}
          onCancel={close}
          onSave={async (data) => {
            await editMutation.mutate(data);
            close();
          }}
        />
      ),
      { title: t().editNamed({ name: props.fqdn }), icon: "ti ti-pencil", size: "large" },
    );
  };
  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteHostConfirm({ host: props.fqdn }), {
      title: t().deleteHost,
      icon: "ti ti-trash",
      confirmText: t().delete,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await deleteMutation.mutate();
    }
  };
  const handleAddToGroup = () => {
    prompts.dialog(
      (close) => (
        <HostgroupSearch
          exclude={props.memberofHostgroup}
          adding={addToGroupMutation.loading()}
          onSelect={async (cn: string) => {
            close();
            await addToGroupMutation.mutate(cn);
          }}
        />
      ),
      { title: t().addToGroup, icon: "ti ti-server-cog" },
    );
  };
  return (
    <Dropdown.Root
      position="bottom-left"
      width="11rem"
      items={[
        {
          items: [
            { icon: "ti ti-pencil", label: t().edit, action: handleEdit },
            { icon: "ti ti-folder-plus", label: t().add, action: handleAddToGroup },
            ...(props.currentGroup
              ? [
                  {
                    icon: "ti ti-folder-minus",
                    label: t().remove,
                    action: () => handleRemoveFromGroup(props.currentGroup!),
                    variant: "danger" as const,
                  },
                ]
              : []),
            { icon: "ti ti-trash", label: t().delete, action: handleDelete, variant: "danger" as const },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly size="sm" label={t().hostActions} tooltip={t().manageHost}>
        <i class="ti ti-dots-vertical" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

const EditHostDialog = (props: {
  fqdn: string;
  description: string | null;
  locality: string | null;
  location: string | null;
  macAddress: string[];
  saving?: boolean;
  onCancel: () => void;
  onSave: (data: EditHostPayload) => Promise<void>;
}) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const [description, setDescription] = createSignal(props.description ?? "");
  const [locality, setLocality] = createSignal(props.locality ?? "");
  const [location, setLocation] = createSignal(props.location ?? "");
  const [macAddresses, setMacAddresses] = createSignal<EditableMacAddress[]>(props.macAddress.map((value) => ({ value })));
  const [macErrors, setMacErrors] = createSignal<string[]>([]);

  const updateMac = (index: number, value: string) => {
    setMacAddresses((current) => current.map((entry, currentIndex) => (currentIndex === index ? { ...entry, value } : entry)));
    setMacErrors((current) => current.map((entry, currentIndex) => (currentIndex === index ? "" : entry)));
  };

  const addMac = () => {
    setMacAddresses((current) => [...current, { value: "" }]);
    setMacErrors((current) => [...current, ""]);
  };

  const removeMac = (index: number) => {
    setMacAddresses((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setMacErrors((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleSave = async () => {
    const normalizedMacs = macAddresses().map((entry) => normalizeMacAddress(entry.value));
    const nextErrors = normalizedMacs.map((value, index, values) => {
      if (!value) return t().macRequired;
      if (!MAC_ADDRESS_REGEX.test(value)) return t().macFormat;
      if (values.findIndex((candidate) => candidate === value) !== index) return t().duplicateMac;
      return "";
    });

    setMacErrors(nextErrors);
    if (nextErrors.some(Boolean)) return;

    await props.onSave({
      description: description(),
      locality: locality(),
      location: location(),
      macAddress: normalizedMacs,
    });
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="grid gap-3 md:grid-cols-2">
        <TextInput label={t().description} placeholder={t().optionalDescription} value={description} onValueChange={setDescription} />
        <TextInput label={t().locality} placeholder={t().localityPlaceholder} value={locality} onValueChange={setLocality} />
      </div>
      <TextInput label={t().location} placeholder={t().locationPlaceholder} value={location} onValueChange={setLocation} />

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-medium text-primary">{t().macAddresses}</h3>
            <p class="text-xs text-dimmed">{t().macHint}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={addMac}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().addMac}
          </Button>
        </div>

        <div class="flex flex-col gap-2">
          <Show
            when={macAddresses().length > 0}
            fallback={<Placeholder align="left" class="rounded-xl border border-dashed border-subtle p-3" description={<>{t().noMac}</>} />}
          >
            <Index each={macAddresses()}>
              {(macAddress, index) => (
                <MacAddressRow
                  index={index}
                  value={() => macAddress().value}
                  error={() => macErrors()[index]}
                  onInput={(value) => updateMac(index, value)}
                  onRemove={() => removeMac(index)}
                />
              )}
            </Index>
          </Show>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={props.onCancel} disabled={props.saving}>
          {t().cancel}
        </Button>
        <Button size="sm" onClick={handleSave} loading={props.saving} loadingLabel={t().savingHost}>
          <i class="ti ti-check" aria-hidden="true" />
          {t().save}
        </Button>
      </div>
    </div>
  );
};

// Inline hostgroup search component
const HostgroupSearch = (props: { exclude: string[]; adding?: boolean; onSelect: (cn: string) => void }) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const [search, setSearch] = createSignal("");
  const [results, setResults] = createSignal<{ cn: string; description: string | null }[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [addingCn, setAddingCn] = createSignal<string | null>(null);
  const doSearch = async (q: string) => {
    if (q.length < 1) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiClient.hostgroups.search.$get({ query: { q, exclude: props.exclude.join(",") } });
      if (!res.ok) {
        throw new Error(t().failedSearchGroups);
      }
      const data = await res.json();
      setResults(data.hostgroups);
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().failedSearchGroups);
    } finally {
      setLoading(false);
    }
  };
  const { debouncedFn: debouncedSearch } = timing.debounce(doSearch, 300);
  const handleInput = (value: string) => {
    setSearch(value);
    debouncedSearch(value);
  };
  return (
    <div class="flex flex-col gap-3">
      <TextInput
        type="search"
        placeholder={t().searchGroups}
        aria-label={t().searchGroups}
        icon="ti ti-search"
        activeIcon="ti ti-search"
        value={search}
        onValueChange={handleInput}
        clearable
        clearLabel={t().clearSearch}
        onClear={() => handleInput("")}
      />
      <div class="h-48 overflow-y-auto">
        <Show when={loading()}>
          <div class="flex items-center justify-center py-8 text-dimmed">
            <i class="ti ti-loader-2 animate-spin text-xl" />
          </div>
        </Show>
        <Show when={!loading() && search().length >= 1 && results().length === 0}>
          <div class="flex flex-col items-center justify-center py-8 text-dimmed text-xs">
            <i class="ti ti-search-off text-xl mb-2" /> <span>{t().noGroupsFound}</span>
          </div>
        </Show>
        <Show when={!loading() && search().length < 1}>
          <div class="flex flex-col items-center justify-center py-8 text-dimmed text-xs">
            <i class="ti ti-search text-xl mb-2" /> <span>{t().typeToSearch}</span>
          </div>
        </Show>
        <Show when={!loading() && results().length > 0}>
          <div class="flex flex-col gap-1">
            <For each={results()}>
              {(hg) => (
                <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <div class="flex shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 h-8 w-8 text-xs">
                    <i class="ti ti-server text-sm" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm truncate">{hg.cn}</div>
                    {hg.description && <div class="text-xs text-dimmed truncate">{hg.description}</div>}
                  </div>
                  <Tooltip.Anchor content={t().addHostTo({ name: hg.cn })}>
                    <IconButton
                      size="sm"
                      variant="success"
                      label={t().addHostTo({ name: hg.cn })}
                      onClick={() => {
                        setAddingCn(hg.cn);
                        props.onSelect(hg.cn);
                      }}
                      disabled={addingCn() !== null && addingCn() !== hg.cn}
                      loading={addingCn() === hg.cn || props.adding}
                      loadingLabel={t().addingHostTo({ name: hg.cn })}
                    >
                      <i class="ti ti-plus" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
export default HostActions;
