import { Checkbox, NoticeCard, NumberInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { createDraftForm, oneStepFailure, SaveRejected } from "../_components/draft-form";
import { SaveOutcome } from "../_components/SaveOutcome";
import { apiClient as loggingClient } from "../logs/api-client";

export type RetentionValues = { logs: number; events: number; rollups: number };
type Key = keyof RetentionValues;

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
    const message = body?.message ?? t().notSaved;
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

  const form = createDraftForm<RetentionValues>({
    initial: props.values,
    locale,
    validate: (value) =>
      Object.fromEntries(
        (Object.keys(value) as Key[])
          .filter((key) => !Number.isInteger(value[key]) || value[key] < 1)
          .map((key) => [key, t().atLeastOneDay]),
      ),
    pending: () => (Object.keys(unreadable()) as Key[]).some((key) => confirmed(key)),
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
  const unreadableKeys = () => (Object.keys(unreadable()) as Key[]).filter((key) => unreadable()[key]);
  const field = (key: Key, help: string) => (
    <NumberInput
      label={label(key)}
      description={help}
      min={1}
      suffix={t().days}
      value={() => form.draft()[key]}
      onValueChange={(days) => form.update({ [key]: days ?? 0 } as Partial<RetentionValues>)}
      error={() => form.errors()[key]}
      disabled={form.saving() || (unreadable()[key] === true && !replace()[key])}
    />
  );
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SaveOutcome t={t()} outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={unreadableKeys().length > 0}>
        <NoticeCard tone="warning" title={g().unreadableTitle} detail={g().unreadableDetail}>
          <For each={unreadableKeys()}>
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
      {field("logs", t().logRetentionHelp)}
      {field("events", t().eventRetentionHelp)}
      {field("rollups", t().rollupRetentionHelp)}
    </div>
  );
}
