import type { StatusTone } from "@k2b/ui";
import { gatewayOpsMessages } from "../messages";

export type OverviewSignalSeverity = "critical" | "warning" | "unavailable";

type OverviewSignal = {
  id: string;
  severity: OverviewSignalSeverity;
  icon: string;
  title: string;
  detail: string;
  href: string;
};

type OverviewVerdict = {
  tone: StatusTone;
  label: string;
  description: string;
};

export type OverviewSignalInput = {
  range: string;
  jobsWindow: string;
  offlineApps: string[];
  serverErrors: number;
  rateLimited: number;
  failedRuns: number;
  stuckRuns: number;
  logErrors: number;
  unavailable: Partial<Record<"apps" | "telemetry" | "runs" | "logs", string>>;
};

const summarizeApps = (apps: string[], locale?: string): string => {
  const { t } = gatewayOpsMessages.resolve([locale ?? "en"]);
  const visible = apps.slice(0, 4);
  const remaining = apps.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} ${t.moreItems({ count: remaining })}` : visible.join(", ");
};

/** Turn independent aggregates into a short, priority-ordered operator queue. */
export const buildOverviewSignals = (input: OverviewSignalInput, locale = "en"): OverviewSignal[] => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const signals: OverviewSignal[] = [];

  if (input.offlineApps.length > 0) {
    signals.push({
      id: "offline-apps",
      severity: "critical",
      icon: "ti ti-plug-connected-x",
      title: t.appsOfflineTitle({ count: input.offlineApps.length }),
      detail: summarizeApps(input.offlineApps, locale),
      href: "/admin/gateway/apps",
    });
  }
  if (input.serverErrors > 0) {
    signals.push({
      id: "server-errors",
      severity: "critical",
      icon: "ti ti-alert-circle",
      title: t.serverErrorCount({ count: input.serverErrors }),
      detail: t.http5xxInRange({ range: input.range }),
      href: `/admin/observability/telemetry?range=${input.range}&errors=1`,
    });
  }
  if (input.stuckRuns > 0) {
    signals.push({
      id: "stuck-runs",
      severity: "critical",
      icon: "ti ti-clock-exclamation",
      title: t.stuckRunsTitle({ count: input.stuckRuns }),
      detail: t.stuckRunsDetail,
      href: `/admin/observability/jobs?window=${input.jobsWindow}&health=stuck`,
    });
  }

  const unavailableSignals = [
    ["apps", t.appHealthUnavailable, "/admin/gateway/apps"],
    ["telemetry", t.trafficSignalsUnavailable, `/admin/observability/telemetry?range=${input.range}`],
    ["runs", t.runSignalsUnavailable, `/admin/observability/jobs?window=${input.jobsWindow}`],
    ["logs", t.logSignalsUnavailable, "/admin/observability/logs"],
  ] as const;
  for (const [source, title, href] of unavailableSignals) {
    const detail = input.unavailable[source];
    if (!detail) continue;
    signals.push({
      id: `unavailable-${source}`,
      severity: "unavailable",
      icon: "ti ti-database-off",
      title,
      detail,
      href,
    });
  }

  if (input.failedRuns > 0) {
    signals.push({
      id: "failed-runs",
      severity: "warning",
      icon: "ti ti-x",
      title: t.failedRunsTitle({ count: input.failedRuns }),
      detail: t.failedRunsDetail({ window: input.jobsWindow }),
      href: `/admin/observability/jobs?window=${input.jobsWindow}&health=failed`,
    });
  }
  if (input.rateLimited > 0) {
    signals.push({
      id: "rate-limited",
      severity: "warning",
      icon: "ti ti-hand-stop",
      title: t.rateLimitedTitle({ count: input.rateLimited }),
      detail: t.http429InRange({ range: input.range }),
      href: `/admin/observability/telemetry?range=${input.range}`,
    });
  }
  if (input.logErrors > 0) {
    signals.push({
      id: "log-errors",
      severity: "warning",
      icon: "ti ti-file-alert",
      title: t.loggedErrorsTitle({ count: input.logErrors }),
      detail: t.loggedErrorsDetail,
      href: "/admin/observability/logs?level=error",
    });
  }

  return signals;
};

export const overviewVerdict = (signals: OverviewSignal[], locale = "en"): OverviewVerdict => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const critical = signals.filter((signal) => signal.severity === "critical").length;
  const unavailable = signals.filter((signal) => signal.severity === "unavailable").length;
  const warning = signals.filter((signal) => signal.severity === "warning").length;

  if (critical > 0) {
    return {
      tone: "error",
      label: t.needsAttention,
      description: t.criticalSignalsDetected({ critical, unavailable }),
    };
  }
  if (unavailable > 0) {
    return {
      tone: "degraded",
      label: t.visibilityDegraded,
      description: t.unavailableSourcesDescription({ count: unavailable }),
    };
  }
  if (warning > 0) {
    return {
      tone: "warning",
      label: t.reviewSignals,
      description: t.warningSignalsDescription({ count: warning }),
    };
  }
  return {
    tone: "ok",
    label: t.noActiveIncidents,
    description: t.noActiveIncidentsDescription,
  };
};
