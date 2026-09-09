import { crypto } from "@k2b/stdlib";
import {
  Button,
  IconButton,
  Placeholder,
  prompts,
  Select,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { type BaseNavigation, BaseNavigationSchema, type NavigationGroup, navigationReferenceKey } from "../../../navigation-contracts";
import { navigationMessages } from "../../../navigation-messages";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationResource } from "../workspace/navigation-catalog";

export default function NavigationSettingsSection(props: {
  baseId: string;
  resources: NavigationResource[];
  onDirtyChange: (value: boolean) => void;
  onSavingChange: (value: boolean) => void;
}) {
  const { t } = navigationMessages.resolve([useLocale()()]);
  const resources = props.resources;
  const byKey = new Map(resources.map((resource) => [navigationReferenceKey(resource), resource]));
  const [draft, setDraft] = createSignal<BaseNavigation | null>(null);
  const [original, setOriginal] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const controller = new AbortController();
  const dirty = () => draft() !== null && JSON.stringify(draft()) !== original();
  onMount(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty() || busy()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    void load();
    onCleanup(() => window.removeEventListener("beforeunload", warn));
  });
  onCleanup(() => controller.abort());
  const load = async () => {
    if (busy()) return;
    if (dirty() && !(await prompts.confirm(t.discard))) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await apiClient.bases[":baseId"].navigation.$get(
        { param: { baseId: props.baseId } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t.loadFailed));
      const value = BaseNavigationSchema.parse(await response.json());
      setDraft(value);
      setOriginal(JSON.stringify(value));
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t.loadFailed);
    } finally {
      setBusy(false);
    }
  };
  const changeGroups = (update: (groups: NavigationGroup[]) => NavigationGroup[]) =>
    setDraft((current) => (current ? { ...current, groups: update(current.groups) } : null));
  const changeGroup = (id: string, update: (group: NavigationGroup) => NavigationGroup) =>
    changeGroups((groups) => groups.map((group) => (group.id === id ? update(group) : group)));
  const move = <T,>(items: T[], index: number, offset: number): T[] => {
    const next = [...items];
    const target = index + offset;
    if (index < 0 || target < 0 || target >= items.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  };
  const save = async () => {
    const current = draft();
    if (!current || busy()) return;
    const parsed = BaseNavigationSchema.safeParse(current);
    if (!parsed.success) {
      setError(t.invalid);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await apiClient.bases[":baseId"].navigation.$put(
        { param: { baseId: props.baseId }, json: parsed.data },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t.failed));
      const value = BaseNavigationSchema.parse(await response.json());
      setDraft(value);
      setOriginal(JSON.stringify(value));
      setBusy(false);
      window.location.reload();
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t.failed);
    } finally {
      setBusy(false);
    }
  };

  createEffect(() => props.onDirtyChange(dirty()));
  createEffect(() => props.onSavingChange(busy()));
  onCleanup(() => {
    props.onDirtyChange(false);
    props.onSavingChange(false);
  });
  return (
    <>
      <Show when={error()}>
        <Placeholder
          state="error"
          title={error()}
          action={
            <Button variant="secondary" disabled={busy()} onClick={() => void load()}>
              {t.reload}
            </Button>
          }
        />
      </Show>
      <Show
        when={draft()}
        fallback={
          <Show when={!error()}>
            <Placeholder state="loading" title={t.navigation} />
          </Show>
        }
      >
        <section class="flex flex-col gap-4">
          <Show when={draft()!.groups.length === 0}>
            <p class="text-dimmed">{t.noGroups}</p>
          </Show>
          <For each={draft()!.groups.map((group) => group.id)}>
            {(groupId, index) => {
              const group = () => draft()!.groups.find((item) => item.id === groupId)!;
              return (
                <SettingsGroup title={group().name}>
                  <div class="flex items-end gap-2">
                    <div class="min-w-0 flex-1">
                      <TextInput
                        label={t.groupName}
                        required
                        maxLength={200}
                        error={group().name.trim() ? undefined : t.nameRequired}
                        value={group().name}
                        disabled={busy()}
                        onValueChange={(name) => changeGroup(group().id, (current) => ({ ...current, name }))}
                      />
                    </div>
                    <IconButton
                      label={t.up}
                      disabled={busy() || index() === 0}
                      onClick={() => changeGroups((groups) => move(groups, index(), -1))}
                    >
                      <i class="ti ti-arrow-up" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t.down}
                      disabled={busy() || index() === draft()!.groups.length - 1}
                      onClick={() => changeGroups((groups) => move(groups, index(), 1))}
                    >
                      <i class="ti ti-arrow-down" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t.remove}
                      disabled={busy()}
                      onClick={() => changeGroups((groups) => groups.filter((item) => item.id !== group().id))}
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                    </IconButton>
                  </div>
                  <For each={group().entries}>
                    {(entry, entryIndex) => (
                      <div class="flex items-center gap-2">
                        <span class="min-w-0 flex-1 truncate">
                          {byKey.get(navigationReferenceKey(entry))?.name ?? t.unavailable}
                          <span class="ml-2 text-xs text-dimmed">{t[entry.type]}</span>
                        </span>
                        <IconButton
                          label={t.up}
                          disabled={busy() || entryIndex() === 0}
                          onClick={() =>
                            changeGroup(group().id, (current) => ({ ...current, entries: move(current.entries, entryIndex(), -1) }))
                          }
                        >
                          <i class="ti ti-arrow-up" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={t.down}
                          disabled={busy() || entryIndex() === group().entries.length - 1}
                          onClick={() =>
                            changeGroup(group().id, (current) => ({ ...current, entries: move(current.entries, entryIndex(), 1) }))
                          }
                        >
                          <i class="ti ti-arrow-down" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={t.remove}
                          disabled={busy()}
                          onClick={() =>
                            changeGroup(group().id, (current) => ({
                              ...current,
                              entries: current.entries.filter((item) => navigationReferenceKey(item) !== navigationReferenceKey(entry)),
                            }))
                          }
                        >
                          <i class="ti ti-x" aria-hidden="true" />
                        </IconButton>
                      </div>
                    )}
                  </For>
                  <Select
                    label={t.addResource}
                    value={null}
                    disabled={busy()}
                    searchable
                    options={resources
                      .filter(
                        (resource) => !group().entries.some((entry) => navigationReferenceKey(entry) === navigationReferenceKey(resource)),
                      )
                      .map((resource) => ({
                        value: navigationReferenceKey(resource),
                        label: resource.name,
                        description: `${t[resource.type]}${resource.context ? ` · ${resource.context}` : ""}`,
                        icon: resource.icon,
                      }))}
                    onValueChange={(key) => {
                      const resource = key ? byKey.get(key) : undefined;
                      if (resource)
                        changeGroup(group().id, (current) => ({
                          ...current,
                          entries: [...current.entries, { type: resource.type, id: resource.id }],
                        }));
                    }}
                  />
                </SettingsGroup>
              );
            }}
          </For>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy()}
              onClick={() =>
                changeGroups((groups) => {
                  let id = crypto.common.readableId(6);
                  while (groups.some((group) => group.id === id)) id = crypto.common.readableId(6);
                  return [...groups, { id, name: t.groupName, entries: [] }];
                })
              }
            >
              {t.addGroup}
            </Button>
          </div>
        </section>
        <SettingsModal.Footer>
          <SettingsPanelFooter
            changeCount={() => (dirty() ? 1 : 0)}
            loading={busy}
            saveDisabled={() => !BaseNavigationSchema.safeParse(draft()).success}
            onDiscard={() => {
              setDraft(BaseNavigationSchema.parse(JSON.parse(original())));
              setError(undefined);
            }}
            onSave={() => void save()}
          />
        </SettingsModal.Footer>
      </Show>
    </>
  );
}
