import { dates } from "@k2b/stdlib";

export const sqlTimestamp = (value: unknown, type: string): number => {
  if (typeof value === "number") return value * 1000; // ClickHouse Unix seconds.
  if (typeof value !== "string") return Number.NaN;
  const iso = value.replace(" ", "T");
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) return Date.parse(iso);
  const zone = /'([^']+)'/.exec(type)?.[1];
  if (!zone || zone === "UTC" || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return Date.parse(`${iso}${iso.length === 10 ? "T00:00:00" : ""}Z`);
  try {
    return Date.parse(dates.zonedDateTimeToInstant(iso, zone, { disambiguation: "compatible" }));
  } catch {
    return Number.NaN;
  }
};
