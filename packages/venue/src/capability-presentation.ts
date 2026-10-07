import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

const venueIdInput = "Standort-ID aus „Standorte suchen“, „Zugängliche Standorte auflisten“ oder einem venue.venue-Ref.";
const cursorInput = "Cursor, den die vorherige Seite zurückgegeben hat.";
const limitInput = "Höchstzahl der Ergebnisse.";
const templateIdInput = "Schichtvorlagen-ID aus shift.list.";
const dateInput = "Datum der Schicht in der Zeitzone des Standorts, aus shift.list.";

export const venueCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        assignment: {
          title: "Schichteinsatz",
          description: "Dein Platz in einer Schicht eines Standorts an einem bestimmten Tag.",
        },
        venue: {
          title: "Standort",
          description: "Ein öffentlicher oder zugriffsgeschützter Ort mit Öffnungszeiten und Schichtregeln.",
        },
      },
      queries: {
        "assignment.mine": {
          title: "Meine Schichteinsätze auflisten",
          description:
            "Listet deine Schichteinsätze auf, optional nur für eine venueId aus venue.list oder venue.search. Nutze die zurückgegebenen venue.assignment-Refs mit assignment.read oder assignment.cancel.",
          input: {
            venueId: "Optional: nur Einsätze an diesem Standort.",
            from: "Beginn des Zeitraums; standardmäßig jetzt.",
            days: "Anzahl der 24-Stunden-Zeiträume ab from.",
            cursor: cursorInput,
            limit: limitInput,
          },
        },
        "assignment.read": {
          title: "Meinen Schichteinsatz lesen",
          description: "Liest einen eigenen venue.assignment-Ref, den assignment.mine oder das Übernehmen einer Schicht zurückgegeben hat.",
          input: {
            id: "ID deines Schichteinsatzes aus „Meine Schichteinsätze auflisten“ oder einem venue.assignment-Ref.",
          },
        },
        "feedback.summary": {
          title: "Feedback-Übersicht eines Standorts abrufen",
          description:
            "Liest die Bewertungen der letzten 30 Tage als Übersicht, ohne die anonymen Kommentare zu laden. Braucht die Berechtigung write oder admin, wie venue.list sie angibt; die venueId kommt aus venue.list oder venue.search.",
          input: {
            venueId: venueIdInput,
          },
        },
        "shift.list": {
          title: "Schichten eines Standorts auflisten",
          description:
            "Listet wöchentliche und einmalige Schichten eines bekannten Standorts nach Datum auf, ohne zu zeigen, wer sie übernommen hat. recurring gibt an, ob die Schicht wöchentlich wiederkehrt. Die venueId kommt aus venue.list oder venue.search; nutze venueId, templateId und Datum jeder Schicht mit shift.read oder assignment.signup.",
          input: {
            venueId: venueIdInput,
            startDate: "Erster Tag in der Zeitzone des Standorts; standardmäßig heute.",
            days: "Anzahl der Kalendertage in der Zeitzone des Standorts.",
            cursor: cursorInput,
            limit: limitInput,
          },
        },
        "shift.read": {
          title: "Schicht eines Standorts lesen",
          description:
            "Gezielte Abfrage einer wöchentlichen oder einmaligen Schicht: Liest sie mit venueId, templateId und Datum, die „Schichten eines Standorts auflisten“ gemeinsam zurückgibt.",
          input: {
            venueId: venueIdInput,
            templateId: templateIdInput,
            date: dateInput,
          },
        },
        "venue.list": {
          title: "Zugängliche Standorte auflisten",
          description:
            "Der normale Einstieg für Arbeit an Standorten, auf die du Zugriff hast. Listet sie auf; nutze die zurückgegebenen venue.venue-Refs oder IDs mit venue.read, venue.status, shift.list, assignment.mine oder, bei Berechtigung write oder admin, feedback.summary.",
          input: {
            query: "Optionale Suche in Name, Kurzname oder Beschreibung des Standorts.",
            cursor: cursorInput,
            limit: limitInput,
          },
        },
        "venue.read": {
          title: "Standort lesen",
          description: "Liest einen venue.venue-Ref aus venue.list oder venue.search, ohne Bilder.",
          input: {
            id: venueIdInput,
          },
        },
        "venue.search": {
          title: "Standorte suchen",
          description:
            "Findet einen öffentlichen oder zugänglichen Standort über Name, Kurzname oder Beschreibung, wenn seine ID unbekannt ist. Nutze die zurückgegebenen venue.venue-Refs mit venue.read, venue.status, shift.list oder, bei Berechtigung write oder admin, feedback.summary.",
          input: {
            scope: "Optionaler Kontext, der die Suche eingrenzt.",
            "scope.type": "Ressourcentyp des Suchkontexts.",
            "scope.id": "Feste Ressourcen-ID des Suchkontexts.",
            query: "Eingegebener Suchtext. Er darf leer sein, wenn ein Filter die Suche eingrenzt.",
            tags: "Suchfilter, die diese Abfrage unterstützt.",
            limit: limitInput,
          },
          searchTags: {
            venue: {
              title: "Standorte",
              description: "Nur Standorte anzeigen.",
            },
          },
        },
        "venue.status": {
          title: "Status eines Standorts abrufen",
          description:
            "Ruft ab, ob ein bekannter Standort gerade geöffnet ist, seine heutigen Öffnungszeiten und die nächsten Öffnungen. Die venueId kommt aus venue.list oder venue.search.",
          input: {
            venueId: venueIdInput,
          },
        },
      },
      actions: {
        "assignment.cancel": {
          title: "Aus meiner Schicht austreten",
          description:
            "Löscht nur deinen eigenen Schichteinsatz. Gib einen Idempotenzschlüssel mit, damit du einen Versuch mit unklarem Ausgang sicher wiederholen kannst.",
          input: {
            venueId: venueIdInput,
            assignmentId: "ID deines Schichteinsatzes aus „Meine Schichteinsätze auflisten“ oder einem venue.assignment-Ref.",
          },
        },
        "assignment.signup": {
          title: "Schicht übernehmen",
          description:
            "Legt einen Schichteinsatz für eine wöchentliche oder einmalige Schicht an einem Tag an, den shift.list zurückgegeben hat. Der Aufruf ist nicht idempotent.",
          input: {
            venueId: venueIdInput,
            templateId: templateIdInput,
            date: dateInput,
          },
        },
        "assignment.signup_free": {
          title: "Freien Zeitraum eintragen",
          description:
            "Trägt dich für einen freien Zeitraum mit genauem Beginn und Ende ein, höchstens 24 Stunden lang und innerhalb des nächsten Jahres. Der Aufruf ist nicht idempotent.",
          input: {
            venueId: venueIdInput,
            startsAt: "Genauer Beginn nach RFC 3339 mit Zeitzonenabstand.",
            endsAt: "Genaues Ende nach RFC 3339 mit Zeitzonenabstand.",
            note: "Optionale private Notiz zu diesem Einsatz.",
          },
        },
      },
    },
  },
};
