import { Button, ButtonLink, DataTable, type DataTableColumn, StatusBadge } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { AlertAttention } from "../../service/base-attention";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext } from "./helpers";

/**
 * Fired alerts and alerts that cannot be checked, above the sources. The server orders them (critical, warning, error,
 * no data; older first) and sends at most 50. Each row says the condition in words, the value and since when, and
 * offers "Adjust with Gustav" and the alert's SQL.
 */
export default function FiredAlerts(props: {
  alerts: AlertAttention[];
  /** `?alert=` on the base: the list marks this alert. */
  selectedAlertId?: string;
  dateContext: PulseDateContext;
  sqlHref: (alertId: string) => string;
  adjust: (alertId: string) => void;
  adjustPending: boolean;
}) {
  const t = usePulseMessages();
  const columns = (): DataTableColumn<AlertAttention>[] => [
    { id: "alert", header: t().alertDetailsTitle, cellClass: "min-w-56 max-sm:min-w-0" },
    { id: "since", header: t().alertSince, headerClass: "max-sm:hidden", cellClass: "w-56 whitespace-nowrap max-sm:hidden" },
    { id: "actions", header: "", cellClass: "w-px whitespace-nowrap" },
  ];
  const title = (alert: AlertAttention) =>
    alert.state === "firing"
      ? t().alertFired({ name: alert.name })
      : alert.state === "error"
        ? t().alertCannotCheck({ name: alert.name })
        : t().alertNoData({ name: alert.name });
  const condition = (alert: AlertAttention) =>
    alert.threshold === null
      ? alert.errorCode
        ? t().alertCheckFailed({ code: alert.errorCode })
        : ""
      : t().alertConditionWords({ comparison: alert.comparison, threshold: String(alert.threshold) });
  const since = (alert: AlertAttention) => {
    const time = compactDateWithDelta(alert.since, props.dateContext);
    return alert.value === null ? t().storeDownSince({ time }) : t().alertSinceValue({ since: time, value: String(alert.value) });
  };
  const badge = (alert: AlertAttention) =>
    alert.state === "firing" ? (
      <StatusBadge
        tone={alert.severity === "critical" ? "error" : "warning"}
        label={alert.severity === "critical" ? t().severityCritical : t().severityWarning}
      />
    ) : (
      <StatusBadge tone="neutral" label={alert.state === "error" ? t().error : t().noDataYet} />
    );
  const cell = (alert: AlertAttention, col: DataTableColumn<AlertAttention>): JSX.Element => {
    if (col.id === "alert")
      return (
        <div class="flex min-w-0 items-start gap-2">
          {badge(alert)}
          <div class="min-w-0">
            <p class="text-sm font-medium text-primary">{title(alert)}</p>
            <p class="mt-0.5 text-xs text-dimmed">{condition(alert)}</p>
            <p class="mt-0.5 text-xs text-dimmed sm:hidden">{since(alert)}</p>
          </div>
        </div>
      );
    if (col.id === "since") return <span class="text-xs text-secondary">{since(alert)}</span>;
    return (
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={props.adjustPending} onClick={() => props.adjust(alert.reference)}>
          <i class="ti ti-sparkles" aria-hidden="true" />
          {t().adjustWithGustav}
        </Button>
        <ButtonLink class="max-sm:hidden" variant="ghost" size="sm" href={props.sqlHref(alert.reference)}>
          {t().openAlertSql}
        </ButtonLink>
      </div>
    );
  };
  return (
    <section class="flex shrink-0 flex-col gap-2">
      <h2 class="text-sm font-semibold text-primary">{t().attentionTitle}</h2>
      <DataTable
        rows={props.alerts}
        columns={columns()}
        getRowId={(alert) => alert.reference}
        selectedRowId={props.selectedAlertId || null}
        density="compact"
        ariaLabel={t().attentionTitle}
        renderCell={({ row, col }) => cell(row, col)}
      />
    </section>
  );
}
