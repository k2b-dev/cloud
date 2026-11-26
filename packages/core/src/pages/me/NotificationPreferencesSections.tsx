import { apiClient } from "@k2b/cloud/clients/core";
import type { UserNotificationPreference, UserNotificationPreferencesResponse } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { Button, Chip, Empty, Inline, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import { notificationChannelAvailability, notificationChannelMeta } from "./notification-ui";

export type NotificationAppMeta = { id: string; name: string; icon: string; color?: string };

type PreferenceChange = { type: "set"; channels: string[] } | { type: "reset"; channels: string[] };

/** One kind of notification: its channels as switches that save at once and return when the save fails. */
const Preference = (props: { preference: UserNotificationPreference; availableChannels: string[] }) => {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const excluded = new Set(props.preference.excludedChannels);
  const required = new Set(props.preference.requiredChannels);
  const available = new Set(props.availableChannels);
  const [selected, setSelected] = createSignal(props.preference.selectedChannels.filter((channel) => !excluded.has(channel)));
  const [customized, setCustomized] = createSignal(props.preference.customized);
  const [busy, setBusy] = createSignal(false);
  const optionalChannels = [
    ...new Set([...props.availableChannels, ...props.preference.recommendedChannels, ...props.preference.selectedChannels]),
  ].filter((channel) => !required.has(channel));
  const defaults = props.preference.recommendedChannels.filter((channel) => !required.has(channel) && !excluded.has(channel));

  const update = async (change: PreferenceChange) => {
    if (busy()) return;
    const previous = { selected: selected(), customized: customized() };
    setSelected(change.channels);
    setCustomized(change.type === "set");
    setBusy(true);
    try {
      const endpoint = apiClient.me.notifications.preferences[":definitionId"];
      const response =
        change.type === "reset"
          ? await endpoint.$delete({ param: { definitionId: props.preference.id } })
          : await endpoint.$put({ param: { definitionId: props.preference.id }, json: { channels: change.channels } });
      const data = await response.json();
      if (!response.ok) throw new Error(t().notificationPreferenceSaveFailed);
      const saved = data as UserNotificationPreference;
      setSelected(saved.selectedChannels);
      setCustomized(saved.customized);
      toast(t().notificationPreferenceSaved, { status: "ok" });
    } catch (error) {
      setSelected(previous.selected);
      setCustomized(previous.customized);
      toast(error instanceof Error ? error.message : t().notificationPreferenceSaveFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (channel: string, enabled: boolean) =>
    void update({
      type: "set",
      channels: enabled ? [...new Set([...selected(), channel])] : selected().filter((value) => value !== channel),
    });
  const availability = (channel: string) =>
    notificationChannelAvailability(available.has(channel), locale(), excluded.has(channel) ? props.preference.excludedReason : undefined);
  /** What the dimmed channels need, in one quiet line under the switches. */
  const reasons = () =>
    [
      ...(props.preference.requiredChannels.length > 0 ? [t().requiredChannelDescription] : []),
      ...new Set(optionalChannels.map((channel) => availability(channel).description).filter((reason): reason is string => !!reason)),
    ].join(" ");

  // k2b-ui gap: `Setting` (#4223) keeps the name column at least 240 px wide at 1024 and on the phone; a row wraps it.
  // The kind's channels as chips to press at the row's end; a channel the app always uses stands as a plain tag.
  return (
    <Row
      lines={
        reasons()
          ? [props.preference.label, props.preference.description, reasons()]
          : [props.preference.label, props.preference.description]
      }
      meta={customized() ? t().customized : undefined}
      end={
        <Inline>
          <For each={props.preference.requiredChannels}>
            {(channel) => (
              <Chip tag icon={notificationChannelMeta(channel, locale()).icon.replace(/^ti ti-/, "")}>
                {t().requiredChannel({ label: notificationChannelMeta(channel, locale()).label })}
              </Chip>
            )}
          </For>
          <For each={optionalChannels}>
            {(channel) => {
              const on = () => !excluded.has(channel) && selected().includes(channel);
              const usable = () => !busy() && !excluded.has(channel) && availability(channel).enabled;
              return (
                // on or off in words and symbol too, not only in the tint
                <Chip icon={on() ? "check" : "minus"} pressed={on()} onClick={usable() ? () => toggle(channel, !on()) : undefined}>
                  {(on() ? t().channelOn : t().channelOff)({ channel: notificationChannelMeta(channel, locale()).label })}
                </Chip>
              );
            }}
          </For>
          <Show when={props.preference.requiredChannels.length === 0 && optionalChannels.length === 0}>
            <Text muted type="meta">
              {t().noDeliveryChannel}
            </Text>
          </Show>
          <Show when={customized()}>
            <Button
              variant="ghost"
              icon="restore"
              label={t().useAppDefault}
              disabled={busy()}
              onClick={() => void update({ type: "reset", channels: defaults })}
            />
          </Show>
        </Inline>
      }
    />
  );
};

/** Notifications › one section per app with the kinds of notifications it sends. */
export default function NotificationPreferencesSections(props: {
  initial: UserNotificationPreferencesResponse;
  apps: NotificationAppMeta[];
}) {
  const t = useAccountMessages();
  const appMetadata = new Map(props.apps.map((app) => [app.id, app]));
  const groups = [...new Set(props.initial.definitions.map((definition) => definition.appId))]
    .map((appId) => ({
      app: appMetadata.get(appId) ?? { id: appId, name: appId, icon: "ti ti-app-window" },
      definitions: props.initial.definitions.filter((definition) => definition.appId === appId),
    }))
    .sort((left, right) => left.app.name.localeCompare(right.app.name));
  return (
    <Show when={groups.length > 0} fallback={<Empty icon="bell-off" text={t().noConfigurableNotifications} />}>
      <For each={groups}>
        {(group) => (
          <Section
            icon={group.app.icon.replace(/^ti ti-/, "")}
            color={group.app.color}
            title={group.app.name}
            count={group.definitions.length}
          >
            <For each={group.definitions}>
              {(preference) => <Preference preference={preference} availableChannels={props.initial.availableChannels} />}
            </For>
          </Section>
        )}
      </For>
    </Show>
  );
}
