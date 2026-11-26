import { createSettingsDraft, oneStepFailure, SaveRejected } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Band, Field, Input } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { apiClient } from "../../api/client";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { SettingsOutcome, UnreadableValues } from "../_components/SettingsOutcome";
import { apiClient as loggingClient } from "../logs/api-client";

export type RetentionValues = { logs: number; events: number; rollups: number };
type Key = keyof RetentionValues;
const KEYS = ["logs", "events", "rollups"] as const;

const SETTING: Record<Exclude<Key, "logs">, string> = {
  events: "gateway.telemetry_event_retention_days",
  rollups: "gateway.telemetry_rollup_retention_days",
};

/**
 * How long Cloud keeps logs and request data. Only changed values are written, one after another. An unreadable
 * stored value is replaced only after the person confirms it, also when the server reports it only on save.
 */
export default function RetentionForm(props: { values: RetentionValues; unreadable: Partial<Record<Key, boolean>> }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [unreadable, setUnreadable] = createSignal<Partial<Record<Key, boolean>>>({ ...props.unreadable });
  const [replace, setReplace] = createSignal<Partial<Record<Key, boolean>>>({});
  const label = (key: Key) => ({ logs: t().logRetention, events: t().eventRetention, rollups: t().rollupRetention })[key];
  const help = (key: Key) => ({ logs: t().logRetentionHelp, events: t().eventRetentionHelp, rollups: t().rollupRetentionHelp })[key];
  let stored = props.values;

  // After the server reports an unreadable value, read from its owner which values are unreadable now.
  const refreshUnreadable = async (key: Key) => {
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
  const rejected = async (key: Key, response: Pick<Response, "json" | "status">): Promise<never> => {
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
  const confirmed = (key: Key) => unreadable()[key] === true && replace()[key] === true;

  const form = createSettingsDraft<RetentionValues>({
    initial: props.values,
    locale,
    validate: (value) =>
      Object.fromEntries(KEYS.filter((key) => !Number.isInteger(value[key]) || value[key] < 1).map((key) => [key, t().atLeastOneDay])),
    pending: () => KEYS.some((key) => confirmed(key)),
    save: async (value, commit) => {
      // Each value is written on its own; after a partial failure the stored state is what reached the server.
      if (value.logs !== stored.logs || confirmed("logs")) {
        const response = await loggingClient.settings.retention.$put({
          json: { retentionDays: value.logs, replaceUnreadable: confirmed("logs") },
        });
        if (!response.ok) await rejected("logs", response);
        stored = { ...stored, logs: value.logs };
        setUnreadable({ ...unreadable(), logs: false });
        commit(stored);
      }
      for (const key of ["events", "rollups"] as const) {
        if (value[key] === stored[key] && !confirmed(key)) continue;
        const response = await apiClient.settings[":key{.+}"].$put({
          param: { key: SETTING[key] },
          json: confirmed(key) ? { value: value[key], replaceUnreadable: true } : { value: value[key] },
        });
        if (!response.ok) await rejected(key, response);
        stored = { ...stored, [key]: value[key] };
        setUnreadable({ ...unreadable(), [key]: false });
        commit(stored);
      }
      return stored;
    },
  });
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
      <Band>
        <For each={KEYS}>
          {(key) => (
            <Field label={label(key)} hint={help(key)} optional={t().days} error={form.errors()[key]}>
              <Input
                type="number"
                min={1}
                value={String(form.draft()[key])}
                onInput={(text) => form.update({ [key]: text === "" ? 0 : Number(text) })}
                disabled={form.saving() || (unreadable()[key] === true && !replace()[key])}
              />
            </Field>
          )}
        </For>
      </Band>
    </>
  );
}
