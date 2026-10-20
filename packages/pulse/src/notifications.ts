import { notification } from "@k2b/cloud";
import { z } from "zod";

const german = (locale: string) => locale.startsWith("de");
export const NOTIFICATIONS = {
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
