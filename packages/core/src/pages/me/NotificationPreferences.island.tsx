import { mutation as mutations } from "@k2b/stdlib/solid";
import { Checkbox, Placeholder, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import type { UserNotificationPreference, UserNotificationPreferencesResponse } from "@k2b/cloud/contracts";
import { createSignal, For, Show } from "solid-js";
import { accountMessages } from "./messages";
import { notificationChannelAvailability, notificationChannelMeta } from "./notification-ui";

export type NotificationAppMeta = { id: string; name: string; icon: string };

type PreferenceMutation = { type: "set"; channels: string[] } | { type: "reset"; channels: string[] };

const PreferenceRow = (props: { preference: UserNotificationPreference; availableChannels: string[] }) => {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [selected, setSelected] = createSignal([...props.preference.selectedChannels]);
  const [customized, setCustomized] = createSignal(props.preference.customized);
  const required = new Set(props.preference.requiredChannels);
  const available = new Set(props.availableChannels);
  const optionalChannels = [
    ...new Set([...props.availableChannels, ...props.preference.recommendedChannels, ...props.preference.selectedChannels]),
  ].filter((channel) => !required.has(channel));

  const update = mutations.create<UserNotificationPreference, PreferenceMutation, { selected: string[]; customized: boolean }>({
    onBefore: (change) => {
      const previous = { selected: selected(), customized: customized() };
      setSelected(change.channels);
      setCustomized(change.type === "set");
      return previous;
    },
    mutation: async (change) => {
      const endpoint = apiClient.me.notifications.preferences[":definitionId"];
      const response =
        change.type === "reset"
          ? await endpoint.$delete({ param: { definitionId: props.preference.id } })
          : await endpoint.$put({ param: { definitionId: props.preference.id }, json: { channels: change.channels } });
      const data = await response.json();
      if (!response.ok) throw new Error(t().notificationPreferenceSaveFailed);
      return data as UserNotificationPreference;
    },
    onSuccess: (preference) => {
      setSelected(preference.selectedChannels);
      setCustomized(preference.customized);
      toast.success(t().notificationPreferenceSaved);
    },
    onError: (error, previous) => {
      if (previous) {
        setSelected(previous.selected);
        setCustomized(previous.customized);
      }
      toast.error(error.message);
    },
  });

  const toggleChannel = (channel: string, enabled: boolean) => {
    const next = enabled ? [...new Set([...selected(), channel])] : selected().filter((value) => value !== channel);
    void update.mutate({ type: "set", channels: next });
  };

  const defaults = props.preference.recommendedChannels.filter((channel) => !required.has(channel));

  return (
    <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)] lg:items-start">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-medium text-primary">{props.preference.label}</h3>
          <span
            class={`tag ${customized() ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-zinc-100 text-dimmed dark:bg-zinc-800"}`}
          >
            {customized() ? t().customized : t().appDefault}
          </span>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-dimmed">{props.preference.description}</p>
        <Show when={customized()}>
          <button
            type="button"
            class="mt-2 inline-flex items-center gap-1 text-xs text-secondary hover:text-primary disabled:opacity-50"
            disabled={update.loading()}
            onClick={() => void update.mutate({ type: "reset", channels: defaults })}
          >
            <i class="ti ti-restore" />
            {t().useAppDefault}
          </button>
        </Show>
      </div>

      <div class="flex min-w-0 flex-col gap-2">
        <For each={props.preference.requiredChannels}>
          {(channel) => {
            const meta = notificationChannelMeta(channel, locale());
            return (
              <Checkbox
                label={t().requiredChannel({ label: meta.label })}
                description={t().requiredChannelDescription}
                value={() => true}
                disabled
              />
            );
          }}
        </For>
        <For each={optionalChannels}>
          {(channel) => {
            const meta = notificationChannelMeta(channel, locale());
            const availability = () => notificationChannelAvailability(available.has(channel), locale());
            return (
              <Checkbox
                label={meta.label}
                description={availability().description}
                value={() => selected().includes(channel)}
                onValueChange={(enabled) => toggleChannel(channel, enabled)}
                disabled={update.loading() || !availability().enabled}
              />
            );
          }}
        </For>
        <Show when={props.preference.requiredChannels.length === 0 && optionalChannels.length === 0}>
          <p class="text-xs text-dimmed">{t().noDeliveryChannel}</p>
        </Show>
      </div>
    </div>
  );
};

export default function NotificationPreferences(props: { initial: UserNotificationPreferencesResponse; apps: NotificationAppMeta[] }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const appMetadata = new Map(props.apps.map((app) => [app.id, app]));
  const groups = [...new Set(props.initial.definitions.map((definition) => definition.appId))]
    .map((appId) => ({
      app: appMetadata.get(appId) ?? { id: appId, name: appId, icon: "ti ti-app-window" },
      definitions: props.initial.definitions.filter((definition) => definition.appId === appId),
    }))
    .sort((left, right) => left.app.name.localeCompare(right.app.name));

  return (
    <Show when={groups.length > 0} fallback={<Placeholder surface="paper" description={<>{t().noConfigurableNotifications}</>} />}>
      <div class="flex flex-col gap-2">
        <For each={groups}>
          {(group) => (
            <section class="paper p-5 sm:p-6">
              <div class="flex items-center gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-secondary dark:bg-zinc-800">
                  <i class={group.app.icon} />
                </span>
                <div class="min-w-0">
                  <h2 class="truncate text-sm font-semibold text-primary">{group.app.name}</h2>
                  <p class="text-xs text-dimmed">{t().notificationTypeCount({ count: group.definitions.length })}</p>
                </div>
              </div>
              <div class="mt-5 flex flex-col gap-6">
                <For each={group.definitions}>
                  {(preference) => <PreferenceRow preference={preference} availableChannels={props.initial.availableChannels} />}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
    </Show>
  );
}
