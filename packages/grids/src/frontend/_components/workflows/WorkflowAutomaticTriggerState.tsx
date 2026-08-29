import { useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { PublicTable } from "../../../api/public-dto";
import type { PublicWorkflowTriggerRuntimeState } from "../workspace/workspace-public-state-model";

import { workflowMessages } from "./messages";

const formatScheduledRun = (value: string, timezone: string, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
};

export function WorkflowAutomaticTriggerState(props: { state: PublicWorkflowTriggerRuntimeState; tables: PublicTable[] }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const scheduleStateLabel = () => ({
    paused: t().paused,
    pending: t().reconciling,
    reconciled: t().scheduled,
    degraded: t().needsAttention,
  });
  const tableLabel = (tableId: string | null): string =>
    tableId ? (props.tables.find((table) => table.id === tableId)?.name ?? t().unavailableTable) : t().anyAccessibleTable;
  return (
    <section class="paper flex flex-wrap items-start gap-x-6 gap-y-2 p-3" aria-label={t().automaticTriggers}>
      <Show when={props.state.schedule}>
        {(schedule) => (
          <div class="min-w-56 flex-1">
            <div class="flex items-center gap-2 text-xs font-medium text-primary">
              <i class="ti ti-calendar-time" aria-hidden="true" />
              <span>{scheduleStateLabel()[schedule().state]}</span>
            </div>
            <p class="mt-1 text-xs text-dimmed">
              <span class="font-mono">{schedule().cron}</span> · {schedule().timezone}
              <Show when={schedule().nextRunAt}>
                {(next) => <> · {t().nextRun({ value: formatScheduledRun(next(), schedule().timezone, locale()) })}</>}
              </Show>
            </p>
            <Show when={schedule().problem}>{(problem) => <p class="mt-1 text-xs text-red-600 dark:text-red-400">{problem()}</p>}</Show>
          </div>
        )}
      </Show>
      <For each={props.state.recordEvents}>
        {(trigger) => (
          <div class="min-w-56 flex-1">
            <div class="flex items-center gap-2 text-xs font-medium text-primary">
              <i class="ti ti-bolt" aria-hidden="true" />
              <span>{trigger.state === "active" ? t().enabled : t().paused}</span>
            </div>
            <p class="mt-1 text-xs text-dimmed">
              {tableLabel(trigger.tableId)} · {trigger.event}
              {trigger.hasFilter ? ` · ${t().filtered}` : ` · ${t().allMatchingRecords}`}
            </p>
          </div>
        )}
      </For>
    </section>
  );
}
