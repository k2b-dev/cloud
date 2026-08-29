import { i18n } from "@k2b/stdlib";
import type { DslQueryCompletionItem } from "../contracts";

const deDetails: Readonly<Record<string, string>> = {
  "Choose a base table": "Basistabelle auswählen",
  "Use a saved view as source": "Gespeicherte Ansicht als Quelle verwenden",
  "Pick output fields": "Ausgabefelder auswählen",
  "Filter rows": "Datensätze filtern",
  "Join through a relation field": "Über ein Relationsfeld verknüpfen",
  "Keep source rows without a match": "Quelldatensätze ohne Treffer behalten",
  "Bucket rows": "Datensätze gruppieren",
  "Calculate grouped values": "Gruppierte Werte berechnen",
  "Filter grouped output": "Gruppierte Ausgabe filtern",
  "Order rows or groups": "Datensätze oder Gruppen sortieren",
  "Full-text search": "Volltextsuche",
  "Maximum rows": "Maximale Anzahl Datensätze",
  "Skip rows": "Datensätze überspringen",
  "Include trashed records": "Datensätze im Papierkorb einschließen",
  "Only trashed records": "Nur Datensätze im Papierkorb",
  "Base table": "Basistabelle",
  "Saved view": "Gespeicherte Ansicht",
  "Join target table": "Zieltabelle der Verknüpfung",
  "Membership: field equals one listed value": "Zugehörigkeit: Das Feld entspricht einem der aufgeführten Werte",
  "Membership: field equals none of the listed values": "Zugehörigkeit: Das Feld entspricht keinem der aufgeführten Werte",
  "Multi-value field contains every listed value": "Mehrwertiges Feld enthält alle aufgeführten Werte",
  "Case-sensitive text contains": "Text enthält den Wert unter Beachtung der Groß- und Kleinschreibung",
  "Case-sensitive text prefix": "Text beginnt unter Beachtung der Groß- und Kleinschreibung mit dem Wert",
  "Case-sensitive text suffix": "Text endet unter Beachtung der Groß- und Kleinschreibung mit dem Wert",
  "Case-insensitive text contains": "Text enthält den Wert ohne Beachtung der Groß- und Kleinschreibung",
  "Case-insensitive text prefix": "Text beginnt ohne Beachtung der Groß- und Kleinschreibung mit dem Wert",
  "Case-insensitive text suffix": "Text endet ohne Beachtung der Groß- und Kleinschreibung mit dem Wert",
  "Boolean AND": "Boolesches UND",
  "Boolean OR": "Boolesches ODER",
  "Boolean NOT": "Boolesches NICHT",
  equals: "ist gleich",
  "does not equal": "ist ungleich",
  "greater than": "ist größer als",
  "greater than or equal": "ist größer oder gleich",
  "less than": "ist kleiner als",
  "less than or equal": "ist kleiner oder gleich",
  "Name this source scope": "Quellbereich benennen",
  "Source alias": "Alias der Quelle",
  "Name this join scope": "Verknüpfungsbereich benennen",
  "Join equality": "Gleichheit der Verknüpfung",
  "Join condition": "Bedingung der Verknüpfung",
  "Join alias": "Alias der Verknüpfung",
  "Name this aggregate": "Aggregation benennen",
  "Aggregate alias": "Alias der Aggregation",
  "all records": "alle Datensätze",
  "aggregate function": "Aggregationsfunktion",
  "Name this formula output": "Formelausgabe benennen",
  "Select alias": "Alias der Auswahl",
  "Name this output": "Ausgabe benennen",
  "select alias": "Alias der Auswahl",
  "aggregate alias": "Alias der Aggregation",
  "null ordering": "Sortierung leerer Werte",
  "sort direction": "Sortierrichtung",
  "date bucket": "Datumsgruppe",
  "Date granularity": "Datumsgranularität",
  "query context": "Abfragekontext",
  "Search specific fields": "Bestimmte Felder durchsuchen",
  "search text": "Suchtext",
  "record id": "Datensatz-ID",
};

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { detail: ({ value }: { value: string }) => value },
    de: {
      detail: ({ value }) => {
        const direct = deDetails[value];
        if (direct) return direct;
        if (value.startsWith("table · ")) return `Tabelle · ${value.slice("table · ".length)}`;
        if (value.startsWith("view · ")) return `Ansicht · ${value.slice("view · ".length)}`;
        return value;
      },
    },
  },
});

/** Localizes only human-facing completion hints; labels and inserted GQL stay canonical. */
export const presentDslQueryCompletions = (items: readonly DslQueryCompletionItem[], locale?: string): DslQueryCompletionItem[] => {
  const { t } = messages.resolve(locale ? [locale] : []);
  return items.map((item) => (item.detail ? { ...item, detail: t.detail({ value: item.detail }) } : item));
};
