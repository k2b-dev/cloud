import { useLocale } from "@k2b/ui";
import { Chip, Row, Section } from "@k2b/ui/v2";
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
  // the schedule and each record event as one row: what fires, its state, and when or on what
  return (
    <Section title={t().automaticTriggers}>
      <Show when={props.state.schedule}>
        {(schedule) => (
          <Row
            icon="calendar-time"
            lines={[
              scheduleStateLabel()[schedule().state],
              [
                schedule().cron,
                schedule().timezone,
                ...(schedule().nextRunAt
                  ? [t().nextRun({ value: formatScheduledRun(schedule().nextRunAt!, schedule().timezone, locale()) })]
                  : []),
              ].join(" · "),
            ]}
            states={schedule().problem ? <Chip status="bad">{schedule().problem}</Chip> : undefined}
          />
        )}
      </Show>
      <For each={props.state.recordEvents}>
        {(trigger) => (
          // what fires it, once: the workflow's own state stands in its head; only a paused trigger says so
          <Row
            icon="bolt"
            lines={[`${tableLabel(trigger.tableId)} · ${trigger.event}`, trigger.hasFilter ? t().filtered : t().allMatchingRecords]}
            states={trigger.state === "active" ? undefined : <Chip status="warn">{t().paused}</Chip>}
          />
        )}
      </For>
    </Section>
  );
}
