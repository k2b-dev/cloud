import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { type DateContext, i18n } from "@k2b/stdlib";
import type { MaintenanceAdminMessages } from "./messages";
import { formatClock } from "./time";

/** One row per value that exists; an absent end, note or starting app leaves no empty row behind. */
export const activeRows = (
  status: MaintenanceStatus,
  context: { t: MaintenanceAdminMessages; locale: string; dateConfig: DateContext; appNames: Record<string, string>; now: number },
): { label: string; value: string }[] => {
  const { t, locale, dateConfig, appNames, now } = context;
  const clock = (iso: string) => formatClock(iso, { ...dateConfig, locale }, now);
  const starting = status.apps.starting.map((id) => appNames[id] ?? id);
  const apps = t.appsValue({ ready: status.apps.ready, total: status.apps.total });
  return [
    ...(status.startedAt
      ? [{ label: t.since, value: t.sinceValue({ time: clock(status.startedAt), name: status.startedBy?.label || "—" }) }]
      : []),
    ...(status.until ? [{ label: t.plannedUntil, value: t.timeValue({ time: clock(status.until) }) }] : []),
    ...(status.message ? [{ label: t.note, value: status.message }] : []),
    {
      label: t.appsReady,
      value: starting.length ? `${apps} · ${t.appsStarting({ names: i18n.formatList(starting, locale), count: starting.length })}` : apps,
    },
  ];
};
