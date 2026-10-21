import { notification } from "@k2b/cloud";
import { z } from "zod";

export const AlertNoticeSchema = z
  .object({
    baseId: z.string(),
    baseName: z.string(),
    ruleId: z.string(),
    ruleName: z.string(),
    key: z.string().nullable(),
    state: z.enum(["ok", "pending", "firing", "no_data", "error"]),
    severity: z.enum(["warn", "critical"]).nullable(),
    value: z.number().finite().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export const SourceStaleNoticeSchema = z
  .object({
    baseId: z.string(),
    baseName: z.string(),
    sourceId: z.string(),
    sourceName: z.string(),
    stale: z.boolean(),
    newestDataAt: z.string().nullable(),
  })
  .strict();
// Public Cloud presentation limits: title 200 and body 4,000 UTF-16 units.
// Preserve valid Unicode when cutting a data label; the stored key stays intact.
const noticeText = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  const prefix = value.slice(0, limit - 1);
  return `${/[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix}…`;
};
const alertText = (data: z.infer<typeof AlertNoticeSchema>, locale: string) => {
  const de = german(locale);
  const status =
    data.state === "ok"
      ? de
        ? "Wieder im grünen Bereich"
        : "Recovered"
      : data.state === "no_data"
        ? de
          ? "Daten fehlen"
          : "Data missing"
        : data.state === "error"
          ? de
            ? "Prüfung fehlgeschlagen"
            : "Check failed"
          : data.severity === "critical"
            ? de
              ? "Kritischer Alarm"
              : "Critical alert"
            : de
              ? "Warnung"
              : "Warning";
  const value = data.value === null ? "" : ` · ${new Intl.NumberFormat(locale).format(data.value)}`;
  return {
    title: noticeText(`${data.ruleName}: ${status}`, 200),
    body: `${noticeText(`${data.baseName}${data.key === null ? "" : ` · ${data.key}`}`, 4000 - value.length)}${value}`,
    targetHref: `/app/pulse/${encodeURIComponent(data.baseId)}` as const,
  };
};
const sourceText = (data: z.infer<typeof SourceStaleNoticeSchema>, locale: string) => ({
  title: `${data.sourceName}: ${data.stale ? (german(locale) ? "Daten veraltet" : "Data stale") : german(locale) ? "Daten wieder aktuell" : "Data current again"}`,
  body: data.stale
    ? german(locale)
      ? `In „${data.baseName}“ fehlen aktuelle Daten dieser Quelle.`
      : `“${data.baseName}” is missing current data from this source.`
    : german(locale)
      ? `In „${data.baseName}“ liegen wieder aktuelle Daten dieser Quelle vor.`
      : `“${data.baseName}” has current data from this source again.`,
  targetHref: `/app/pulse/${encodeURIComponent(data.baseId)}/sources/${encodeURIComponent(data.sourceId)}` as const,
});
const german = (locale: string) => locale.startsWith("de");
export const NOTIFICATIONS = {
  alert: notification({
    recipient: "user",
    label: "Base alert",
    description: "An alert fires, escalates, fails, misses data or recovers.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: { label: "Alarm einer Basis", description: "Eine Regel schlägt an, eskaliert, scheitert, vermisst Daten oder erholt sich." },
      },
    },
    data: AlertNoticeSchema,
    delivery: { recommended: ["browser", "email"] },
    render: (data, { locale }) => alertText(data, locale),
    email: (data, { locale }) => {
      const text = alertText(data, locale);
      return { subject: text.title, content: text.body };
    },
  }),
  sourceStale: notification({
    recipient: "user",
    label: "Source freshness",
    description: "A source misses its data expectation or becomes current again.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Aktualität einer Quelle",
          description: "Eine Quelle verfehlt ihre Datenerwartung oder liefert wieder aktuelle Daten.",
        },
      },
    },
    data: SourceStaleNoticeSchema,
    delivery: { recommended: ["browser", "email"] },
    render: (data, { locale }) => sourceText(data, locale),
    email: (data, { locale }) => {
      const text = sourceText(data, locale);
      return { subject: text.title, content: text.body };
    },
  }),
  storageThresholdReached: notification({
    recipient: "user",
    label: "Base storage threshold reached",
    description: "A base refuses new values after reaching its storage threshold.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Speichergrenze der Basis erreicht",
          description: "Eine Basis nimmt nach Erreichen ihrer Speichergrenze keine neuen Werte an.",
        },
      },
    },
    data: z.object({ baseName: z.string(), threshold: z.number() }),
    delivery: { recommended: ["browser", "email"] },
    render: ({ baseName, threshold }, { locale }) => ({
      title: german(locale) ? "Speichergrenze erreicht" : "Storage threshold reached",
      body: german(locale)
        ? `„${baseName}“ hat die Speichergrenze von ${threshold} Bytes erreicht. Ein Basis-Admin kann die Aufbewahrung verkürzen, ein Cloud-Admin die Grenze erhöhen.`
        : `“${baseName}” reached its storage threshold of ${threshold} bytes. A base admin can shorten retention or a Cloud admin can raise the threshold.`,
    }),
  }),
  storeDiskLow: notification({
    recipient: "user",
    label: "Data store disk space low",
    description: "Pulse pauses new values when less than 10% of the data store disk is free.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Wenig freier Speicher im Datenspeicher",
          description: "Pulse pausiert neue Werte, wenn weniger als 10 % des Datenträgers frei sind.",
        },
      },
    },
    data: z.object({ freePercent: z.number() }),
    delivery: { recommended: ["browser", "email"] },
    render: ({ freePercent }, { locale }) => ({
      title: german(locale) ? "Wenig freier Speicher" : "Data store disk space low",
      body: german(locale)
        ? `Im Pulse-Datenspeicher sind ${freePercent.toFixed(1)} % frei. Neue Werte werden vorerst abgelehnt.`
        : `The Pulse data store has ${freePercent.toFixed(1)}% free disk space. New values are paused.`,
    }),
  }),
  storeUnavailable: notification({
    recipient: "user",
    label: "Data store unavailable",
    description: "Pulse cannot reach its data store.",
    presentation: {
      baseLocale: "en",
      translations: { de: { label: "Datenspeicher nicht erreichbar", description: "Pulse kann seinen Datenspeicher nicht erreichen." } },
    },
    data: z.object({}),
    delivery: { recommended: ["browser", "email"] },
    render: (_, { locale }) => ({
      title: german(locale) ? "Datenspeicher nicht erreichbar" : "Data store unavailable",
      body: german(locale)
        ? "Pulse kann keine neuen Werte speichern. Prüfe die Verbindung zum Datenspeicher."
        : "Pulse cannot store new values. Check the data store connection.",
    }),
  }),
};
