import { createSettingsDraft, oneStepFailure, SaveRejected, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Field, Input, Section, TagsInput } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { SettingsOutcome, UnreadableValues } from "../_components/SettingsOutcome";
import { apiClient as loggingClient } from "../logs/api-client";

export type GeneralValues = { schedule: string; targets: string[]; logs: number; events: number; rollups: number };
type Key = keyof GeneralValues;
const CHECK_KEYS = ["schedule", "targets"] as const;
const RETENTION_KEYS = ["logs", "events", "rollups"] as const;
const KEYS = [...CHECK_KEYS, ...RETENTION_KEYS] as const;

/** The gateway settings behind the keys; the log retention belongs to the logging API. */
const SETTING: Record<Exclude<Key, "logs">, string> = {
  schedule: "gateway.health_check_schedule",
  targets: "gateway.webhook_allowed_targets",
  events: "gateway.telemetry_event_retention_days",
  rollups: "gateway.telemetry_rollup_retention_days",
};

/**
 * The health check and the retention of operational data: one draft, saved once from the head. Changed values are
 * written one after another; after a partial failure the stored state is what reached the server. A check value the
 * server refuses keeps its reason at its field. An unreadable stored value is replaced only after the person confirms
 * it, also when the server reports it only on save.
 */
export default function GeneralForm(props: { values: GeneralValues; unreadable: Partial<Record<Key, boolean>> }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [unreadable, setUnreadable] = createSignal<Partial<Record<Key, boolean>>>({ ...props.unreadable });
  const [replace, setReplace] = createSignal<Partial<Record<Key, boolean>>>({});
  const [refused, setRefused] = createSignal<Partial<Record<Key, string>>>({});
  const label = (key: Key) =>
    ({
      schedule: t().checkSchedule,
      targets: t().webhookTargets,
      logs: t().logRetention,
      events: t().eventRetention,
      rollups: t().rollupRetention,
    })[key];
  const help = (key: (typeof RETENTION_KEYS)[number]) =>
    ({ logs: t().logRetentionHelp, events: t().eventRetentionHelp, rollups: t().rollupRetentionHelp })[key];
  const confirmed = (key: Key) => unreadable()[key] === true && replace()[key] === true;
  let stored = props.values;

  // After the server reports an unreadable retention value, read from its owner which values are unreadable now.
  const refreshUnreadable = async (key: (typeof RETENTION_KEYS)[number]) => {
    if (key === "logs") {
      const logs = await loggingClient.settings.retention.$get();
      if (!logs.ok) throw new Error(g().recoveryFailed);
      setUnreadable({ ...unreadable(), logs: (await logs.json()).unreadable });
      return;
    }
    const gateway = await apiClient.settings.$get();
    if (!gateway.ok) throw new Error(g().recoveryFailed);
    const entries = (await gateway.json()) as { key: string; unreadable: boolean }[];
    setUnreadable({
      ...unreadable(),
      events: entries.find((entry) => entry.key === SETTING.events)?.unreadable ?? false,
      rollups: entries.find((entry) => entry.key === SETTING.rollups)?.unreadable ?? false,
    });
  };
  const retentionRejected = async (key: (typeof RETENTION_KEYS)[number], response: Pick<Response, "json" | "status">): Promise<never> => {
    const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    const message = body?.message ?? g().saveFailed;
    if (body?.code === "setting_unreadable") {
      try {
        await refreshUnreadable(key);
      } catch (error) {
        throw new SaveRejected(`${message} ${error instanceof Error ? error.message : ""}`.trim());
      }
    }
    throw oneStepFailure(response.status, body, message);
  };
  const written = (key: Key, value: GeneralValues) => {
    stored = { ...stored, [key]: value[key] };
    setUnreadable({ ...unreadable(), [key]: false });
    setReplace({ ...replace(), [key]: false });
  };

  const form = createSettingsDraft<GeneralValues>({
    initial: props.values,
    locale,
    validate: (value): Record<string, string> => ({
      ...(value.schedule.trim() ? {} : { schedule: t().scheduleRequired }),
      ...Object.fromEntries(
        RETENTION_KEYS.filter((key) => !Number.isInteger(value[key]) || value[key] < 1).map((key) => [key, t().atLeastOneDay]),
      ),
    }),
    pending: () => KEYS.some(confirmed),
    // Discard also drops a confirmed replacement, so a later save cannot overwrite an unreadable value it no longer shows.
    onDiscard: () => {
      setRefused({});
      setReplace({});
    },
    save: async (value, commit) => {
      setRefused({});
      const next = { ...value, schedule: value.schedule.trim() };
      for (const key of CHECK_KEYS) {
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
        written(key, next);
        commit(stored);
      }
      if (next.logs !== stored.logs || confirmed("logs")) {
        const response = await loggingClient.settings.retention.$put({
          json: { retentionDays: next.logs, replaceUnreadable: confirmed("logs") },
        });
        if (!response.ok) await retentionRejected("logs", response);
        written("logs", next);
        commit(stored);
      }
      for (const key of ["events", "rollups"] as const) {
        if (next[key] === stored[key] && !confirmed(key)) continue;
        const response = await apiClient.settings[":key{.+}"].$put({
          param: { key: SETTING[key] },
          json: confirmed(key) ? { value: next[key], replaceUnreadable: true } : { value: next[key] },
        });
        if (!response.ok) await retentionRejected(key, response);
        written(key, next);
        commit(stored);
      }
      return stored;
    },
  });
  const disabled = (key: Key) => form.saving() || (unreadable()[key] === true && !replace()[key]);
  const update = (patch: Partial<GeneralValues>) => {
    setRefused((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in patch))));
    form.update(patch);
  };
  return (
    <>
      <SettingsOutcome outcome={form.outcome()} onRetry={() => void form.save()} />
      <UnreadableValues
        keys={KEYS.filter((key) => unreadable()[key])}
        label={label}
        replace={replace()}
        onReplace={(key, checked) => setReplace({ ...replace(), [key]: checked })}
        disabled={form.saving()}
      />
      <Section icon="heart-rate-monitor" title={t().healthCheck} summary={t().healthCheckDescription}>
        <Field label={t().checkSchedule} hint={t().checkScheduleHelp} error={form.errors().schedule ?? refused().schedule}>
          <Input
            icon="calendar-time"
            value={form.draft().schedule}
            onInput={(schedule) => update({ schedule })}
            disabled={disabled("schedule")}
          />
        </Field>
        <Field label={t().webhookTargets} hint={t().webhookTargetsHelp} error={refused().targets} optional={g().optional}>
          <TagsInput
            value={form.draft().targets}
            placeholder={t().webhookTargetsPlaceholder.split(", ")[0]}
            disabled={disabled("targets")}
            onChange={(targets) => update({ targets: targets.map((target) => target.trim()).filter(Boolean) })}
          />
        </Field>
      </Section>
      <Section icon="archive" title={t().retention} summary={t().retentionDescription}>
        <For each={RETENTION_KEYS}>
          {(key) => (
            <Field label={label(key)} hint={help(key)} optional={t().days} error={form.errors()[key]}>
              <Input
                type="number"
                min={1}
                value={String(form.draft()[key])}
                onInput={(text) => update({ [key]: text === "" ? 0 : Number(text) })}
                disabled={disabled(key)}
              />
            </Field>
          )}
        </For>
      </Section>
    </>
  );
}
