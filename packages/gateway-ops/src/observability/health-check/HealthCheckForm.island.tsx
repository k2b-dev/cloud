import SettingsSaveOutcome from "@k2b/cloud/ssr/SettingsSaveOutcome";
import { createSettingsDraft, SaveRejected, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { Checkbox, NoticeCard, TagsInput, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";

export type HealthCheckValues = { schedule: string; targets: string[] };
type Key = keyof HealthCheckValues;
const keys = ["schedule", "targets"] as const;
const SETTING: Record<Key, string> = { schedule: "gateway.health_check_schedule", targets: "gateway.webhook_allowed_targets" };

/**
 * The health check schedule and the internal targets health webhooks may reach. Changed values are written one after
 * another with the button in the level head; a value the server refuses keeps its reason at the field. An unreadable
 * stored value is replaced only after the person confirms it; the displayed fallback can then be saved as it is.
 */
export default function HealthCheckForm(props: { values: HealthCheckValues; unreadable: Partial<Record<Key, boolean>> }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [unreadable, setUnreadable] = createSignal<Partial<Record<Key, boolean>>>({ ...props.unreadable });
  const [replace, setReplace] = createSignal<Partial<Record<Key, boolean>>>({});
  const [refused, setRefused] = createSignal<Partial<Record<Key, string>>>({});
  const confirmed = (key: Key) => unreadable()[key] === true && replace()[key] === true;
  const label = (key: Key) => (key === "schedule" ? t().checkSchedule : t().webhookTargets);
  let stored = props.values;
  const form = createSettingsDraft<HealthCheckValues>({
    initial: props.values,
    locale,
    validate: (value): Record<string, string> => (value.schedule.trim() ? {} : { schedule: t().scheduleRequired }),
    pending: () => keys.some(confirmed),
    // Discard also drops a confirmed replacement, so a later save cannot overwrite an unreadable value it no longer shows.
    onDiscard: () => {
      setRefused({});
      setReplace({});
    },
    save: async (value, commit) => {
      setRefused({});
      const next = { ...value, schedule: value.schedule.trim() };
      for (const key of keys) {
        if (JSON.stringify(next[key]) === JSON.stringify(stored[key]) && !confirmed(key)) continue;
        const response = await apiClient.settings[":key{.+}"].$put({
          param: { key: SETTING[key] },
          json: confirmed(key) ? { value: next[key], replaceUnreadable: true } : { value: next[key] },
        });
        if (!response.ok) {
          const message = await responseErrorMessage(response, g().saveFailed);
          if (response.status === 409) setUnreadable({ ...unreadable(), [key]: true });
          if (response.status !== 400) throw saveFailure(response.status, message);
          setRefused({ [key]: message });
          throw new SaveRejected(t().checkMarkedField);
        }
        stored = { ...stored, [key]: next[key] };
        setUnreadable({ ...unreadable(), [key]: false });
        setReplace({ ...replace(), [key]: false });
        commit(stored);
      }
      return stored;
    },
  });
  const disabled = (key: Key) => form.saving() || (unreadable()[key] === true && !replace()[key]);
  const update = (patch: Partial<HealthCheckValues>) => {
    setRefused((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in patch))));
    form.update(patch);
  };
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SettingsSaveOutcome outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={keys.some((key) => unreadable()[key])}>
        <NoticeCard tone="warning" title={g().unreadableTitle} detail={g().unreadableDetail}>
          <For each={keys.filter((key) => unreadable()[key])}>
            {(key) => (
              <Checkbox
                label={`${g().replaceStored}: ${label(key)}`}
                value={replace()[key] === true}
                onValueChange={(checked) => setReplace({ ...replace(), [key]: checked })}
                disabled={form.saving()}
              />
            )}
          </For>
        </NoticeCard>
      </Show>
      <TextInput
        label={t().checkSchedule}
        description={t().checkScheduleHelp}
        icon="ti ti-calendar-time"
        value={() => form.draft().schedule}
        onValueChange={(schedule) => update({ schedule })}
        error={() => form.errors().schedule ?? refused().schedule}
        disabled={disabled("schedule")}
        required
      />
      <TagsInput
        label={t().webhookTargets}
        description={t().webhookTargetsHelp}
        placeholder={t().webhookTargetsPlaceholder}
        value={() => form.draft().targets}
        onValueChange={(targets) => update({ targets })}
        error={() => refused().targets}
        disabled={disabled("targets")}
      />
    </div>
  );
}
