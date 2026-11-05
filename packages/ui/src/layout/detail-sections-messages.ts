import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Titles and sentences of the shared detail sections: presence, access, links, properties, and tags. */
const detailSectionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      hereNow: "Here now",
      onlyYou: "Only you",
      you: "You",
      writesIn: "in",
      writing: "writing",
      reading: "reading",
      readingAlong: ({ names, count }: { names: string; count: number }) =>
        count > 2 ? `${count} reading along` : `${names} ${count === 1 ? "is" : "are"} reading along`,
      and: "and",
      jumpTo: ({ name, place }: { name: string; place: string }) => `${name}, writing in “${place}”. Jump there`,
      personWriting: ({ name, place }: { name: string; place: string }) => (place ? `${name}, writing in “${place}”` : `${name}, writing`),
      personReading: ({ name }: { name: string }) => `${name}, reading`,
      everyoneHere: ({ count }: { count: number }) => `Here now: all ${count}, with you`,
      presenceLoading: "Loading who is here",
      presenceUnavailable: "Presence is unavailable right now",
      retry: "Try again",
      access: "Access",
      accessLoading: "Loading who has access",
      accessFailed: "Could not load who has access",
      accessSummary: ({ names, more }: { names: string; more: number }) => (more > 0 ? `${names} and ${more} more` : names),
      links: "Links",
      linkedBy: ({ count }: { count: number }) => `Linked from ${count}`,
      linksTo: ({ count }: { count: number }) => `Links to ${count}`,
      linkedBySummary: ({ names, more }: { names: string; more: number }) =>
        more > 0 ? `Linked from ${names} and ${more} more` : `Linked from ${names}`,
      linksToSummary: ({ names, more }: { names: string; more: number }) =>
        more > 0 ? `Links to ${names} and ${more} more` : `Links to ${names}`,
      linksLoading: "Loading links",
      linksFailed: "Could not load all links",
      properties: "Properties",
      tags: "Tags",
    },
    de: {
      hereNow: "Gerade hier",
      onlyYou: "Nur du",
      you: "Du",
      writesIn: "in",
      writing: "schreibt",
      reading: "liest",
      readingAlong: ({ names, count }) => (count > 2 ? `${count} lesen mit` : `${names} ${count === 1 ? "liest" : "lesen"} mit`),
      and: "und",
      jumpTo: ({ name, place }) => `${name}, schreibt in „${place}“. Zur Stelle springen`,
      personWriting: ({ name, place }) => (place ? `${name}, schreibt in „${place}“` : `${name}, schreibt`),
      personReading: ({ name }) => `${name}, liest`,
      everyoneHere: ({ count }) => `Gerade hier: alle ${count}, mit dir`,
      presenceLoading: "Lädt, wer gerade hier ist",
      presenceUnavailable: "Anwesenheit gerade nicht verfügbar",
      retry: "Erneut versuchen",
      access: "Zugriff",
      accessLoading: "Lädt, wer Zugriff hat",
      accessFailed: "Zugriff konnte nicht geladen werden",
      accessSummary: ({ names, more }) => (more > 0 ? `${names} und ${more} weitere` : names),
      links: "Verknüpfungen",
      linkedBy: ({ count }) => `Verlinkt von ${count}`,
      linksTo: ({ count }) => `Verweist auf ${count}`,
      linkedBySummary: ({ names, more }) => (more > 0 ? `Verlinkt von ${names} und ${more} weiteren` : `Verlinkt von ${names}`),
      linksToSummary: ({ names, more }) => (more > 0 ? `Verweist auf ${names} und ${more} weitere` : `Verweist auf ${names}`),
      linksLoading: "Lädt Verknüpfungen",
      linksFailed: "Nicht alle Verknüpfungen konnten geladen werden",
      properties: "Eigenschaften",
      tags: "Tags",
    },
  },
});

export type DetailSectionMessages = ReturnType<(typeof detailSectionMessages)["resolve"]>["t"];

export const useDetailSectionMessages = (): (() => DetailSectionMessages) => {
  const locale = useLocale();
  return () => detailSectionMessages.resolve([locale()]).t;
};

export const checkDetailSectionMessages = () => detailSectionMessages.check();
