import { createSettingsDraft, SaveRejected, saveFailure } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Band, Field, Input } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { SettingsOutcome, UnreadableValues } from "../_components/SettingsOutcome";

export type HealthCheckValues = { schedule: string; targets: string[] };
type Key = keyof HealthCheckValues;
const keys = ["schedule", "targets"] as const;
const SETTING: Record<Key, string> = { schedule: "gateway.health_check_schedule", targets: "gateway.webhook_allowed_targets" };

/** One target per line; blank lines and surrounding spaces do not count. */
const targetList = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The health check schedule and the internal targets health webhooks may reach. Changed values are written one after
 * another with the button in the head; a value the server refuses keeps its reason at the field. An unreadable stored
 * value is replaced only after the person confirms it.
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
      setTargetsText(stored.targets.join("\n"));
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
  // The targets field keeps what the person typed, blank lines included; the draft holds the list it means.
  const [targetsText, setTargetsText] = createSignal(props.values.targets.join("\n"));
  const disabled = (key: Key) => form.saving() || (unreadable()[key] === true && !replace()[key]);
  const update = (patch: Partial<HealthCheckValues>) => {
    setRefused((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in patch))));
    form.update(patch);
  };
  return (
    <>
      <SettingsOutcome outcome={form.outcome()} onRetry={() => void form.save()} />
      <UnreadableValues
        keys={keys.filter((key) => unreadable()[key])}
        label={label}
        replace={replace()}
        onReplace={(key, checked) => setReplace({ ...replace(), [key]: checked })}
        disabled={form.saving()}
      />
      <Band>
        <Field label={t().checkSchedule} hint={t().checkScheduleHelp} error={form.errors().schedule ?? refused().schedule}>
          <Input
            icon="calendar-time"
            value={form.draft().schedule}
            onInput={(schedule) => update({ schedule })}
            disabled={disabled("schedule")}
          />
        </Field>
        <Field label={t().webhookTargets} hint={t().webhookTargetsHelp} error={refused().targets} optional={g().optional}>
          {/* k2b-ui gap: a tags input (one chip per value); until then one target per line */}
          <Input
            multiline
            placeholder={t().webhookTargetsPlaceholder.replace(", ", "\n")}
            value={targetsText()}
            disabled={disabled("targets")}
            onInput={(text) => {
              setTargetsText(text);
              update({ targets: targetList(text) });
            }}
          />
        </Field>
      </Band>
    </>
  );
}
