import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

export const venueCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        assignment: {
          title: "Schichtzuordnung",
          description: "Die konkrete Anmeldung eines Benutzers für eine Venue-Schicht.",
        },
        venue: {
          title: "Venue",
          description: "Ein öffentlicher oder erlaubnispflichtiger Ort mit Öffnungs- und Personalregeln.",
        },
      },
      queries: {
        "assignment.mine": {
          title: "Meine Aufgaben auflisten",
          description:
            "Listen Sie die Zuweisungen des aktuellen Benutzers auf, optional für eine VenueId von venue.list oder venue.search. Verwenden Sie zurückgegebenes venue.assignment refs mit assignment.read oder assignment.cancel.",
          input: {
            venueId: "Optionaler Venue ID-Filter.",
            from: "Bereichsanfang; Die Standardeinstellung ist „jetzt“.",
            days: "Anzahl der 24-Stunden-Zeiträume nach von bis einschließlich.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "assignment.read": {
          title: "Meine Aufgabe lesen",
          description:
            "Lesen Sie einen eigenen venue.assignment ref, der von assignment.mine zurückgegeben wurde, oder eine Zuweisungsanmeldung Action.",
          input: {
            id: "Persönliche Aufgabe ID zurückgegeben von Meine Aufgaben auflisten oder venue.assignment ref.",
          },
        },
        "feedback.summary": {
          title: "Die Zusammenfassung des Venue-Feedbacks abrufen",
          description:
            "Lesen Sie 30-Tage-Bewertungsaggregate für einen bekannten Venue, ohne anonyme Kommentare zu laden. Rufen Sie die Veranstaltungsort-ID von venue.list oder venue.search ab.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
          },
        },
        "shift.list": {
          title: "Liste der Venue-Schichten",
          description:
            "Listen Sie datierte Schichten für einen bekannten Venue ohne Teilnehmeridentitäten auf. Holen Sie sich die Veranstaltungsort-ID von venue.list oder venue.search. Verwenden Sie jede zurückgegebene Veranstaltungsort-ID, Vorlagen-ID und jedes Datum mit shift.read oder assignment.signup.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
            startDate: "Erstes Datum in der Zeitzone Venue; Die Standardeinstellung ist „heute“.",
            days: "Anzahl der einzubeziehenden Venue-lokalen Kalendertage.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "shift.read": {
          title: "Die Venue-Schicht lesen",
          description:
            "Spezialisierte Ereignissuche: Lesen Sie eine datierte Venue-Schicht unter Verwendung der Veranstaltungsort-ID, der Vorlagen-ID und des Datums, die zusammen von der Liste der Venue-Schichten zurückgegeben werden.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
            templateId: "Schichtvorlage ID zurückgegeben von shift.list.",
            date: "Venue – lokales Vorkommensdatum, zurückgegeben von shift.list.",
          },
        },
        "venue.list": {
          title: "Liste zugänglich Venues",
          description:
            "Normaler Eintrag für berechtigungsbezogene Venue-Arbeiten. Listen Sie zugängliches Venues auf und verwenden Sie zurückgegebenes venue.venue refs oder IDs mit venue.read, venue.status, shift.list, assignment.mine oder feedback.summary.",
          input: {
            query: "Optionale Venue-Namens-, Slug- oder Beschreibungssuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "venue.read": {
          title: "Venue lesen",
          description:
            "Lesen Sie einen von venue.list oder venue.search zurückgegebenen venue.venue ref ohne Medien oder geheime Kalendertoken.",
          input: {
            id: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
          },
        },
        "venue.search": {
          title: "Suche Venues",
          description:
            "Suchen Sie einen öffentlichen oder zugänglichen Venue anhand des Namens, des Slugs oder der Beschreibung, wenn sein ID unbekannt ist. Verwenden Sie das zurückgegebene venue.venue refs mit venue.read, venue.status, shift.list oder feedback.summary.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            venue: {
              title: "Venues",
              description: "Nur Venues anzeigen.",
            },
          },
        },
        "venue.status": {
          title: "Den Venue-Status abrufen",
          description:
            "Erhalten Sie den aktuellen Öffnungsstatus, die heutigen Öffnungszeiten und bevorstehende Öffnungen für einen bekannten Venue. Rufen Sie die Veranstaltungsort-ID von venue.list oder venue.search ab.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
          },
        },
      },
      actions: {
        "assignment.cancel": {
          title: "Storniere meinen Schichtauftrag",
          description:
            "Löschen Sie nur die eigene Zuweisung des aktuellen vom Benutzer unterstützten Akteurs. Diese Aktion ist nicht idempotent.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
            assignmentId: "Eigene Zuweisung ID zurückgegeben von Meine Zuweisungen auflisten oder venue.assignment ref.",
          },
        },
        "assignment.signup": {
          title: "Melden Sie sich für die Venue-Schicht an",
          description:
            "Erstellen Sie eine nicht idempotente Zuweisung für ein datiertes Vorlagenvorkommen, das von shift.list zurückgegeben wird.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
            templateId: "Schichtvorlage ID zurückgegeben von shift.list.",
            date: "Venue – lokales Vorkommensdatum, zurückgegeben von shift.list.",
          },
        },
        "assignment.signup_free": {
          title: "Melden Sie sich für die kostenlose Venue-Schicht an",
          description:
            "Erstellen Sie innerhalb des nächsten Jahres eine nicht idempotente kostenlose Aufgabe mit genauen Zeitpunkten für höchstens 24 Stunden.",
          input: {
            venueId: "Venue ID zurückgegeben von Search/List Venues oder einem venue.venue ref.",
            startsAt: "Exakter RFC 3339-Start sofort mit Zeitzonenversatz.",
            endsAt: "Exakter Endzeitpunkt RFC 3339 mit Zeitzonenversatz.",
            note: "Optionale private Notiz für diese Aufgabe.",
          },
        },
      },
    },
  },
};
