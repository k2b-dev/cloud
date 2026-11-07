import { dates } from "@k2b/stdlib";

/**
 * A calendar date (`Date`, `toDate(ts, :base_tz)`) has no zone of its own; `dateZone` names the zone whose
 * midnight it starts at, such as the base's zone on a dashboard.
 */
export const sqlTimestamp = (value: unknown, type: string, dateZone = "UTC"): number => {
  if (typeof value === "number") return value * 1000; // ClickHouse Unix seconds.
  if (typeof value !== "string") return Number.NaN;
  const iso = value.replace(" ", "T");
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) return Date.parse(iso);
  if (dateZone !== "UTC" && /^\d{4}-\d{2}-\d{2}$/.test(iso))
    return Date.parse(dates.zonedDateTimeToInstant(`${iso}T00:00`, dateZone, { disambiguation: "compatible" }));
  const zone = /'([^']+)'/.exec(type)?.[1];
  if (!zone || zone === "UTC" || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return Date.parse(`${iso}${iso.length === 10 ? "T00:00:00" : ""}Z`);
  try {
    return Date.parse(dates.zonedDateTimeToInstant(iso, zone, { disambiguation: "compatible" }));
  } catch {
    return Number.NaN;
  }
};
