import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const weatherCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        location: {
          title: "Gespeicherter Standort",
          description: "Ein gespeicherter Wetterstandort, der dem aktuellen Benutzer gehört.",
        },
      },
      queries: {
        "city.search": {
          title: "Suche deutsche Städte",
          description:
            "Spezialisierter Geokodierungspfad: Finden Sie deutsche Städtekandidaten und Koordinaten. Um einen Ort zu speichern, kopieren Sie den gewählten Namen, optionales Bundesland, Breiten- und Längengrad in „Wetterort speichern“. Stadtergebnisse sind nicht weather.location refs.",
          input: {
            query: "Deutscher Städtename zum Geokodieren; Dies durchsucht Städtekandidaten, nicht gespeicherte Orte.",
            limit: "Maximale Anzahl zurückkehrender Stadtkandidaten.",
          },
        },
        "forecast.current": {
          title: "Das aktuelle Wetter abrufen",
          description:
            "Erhalten Sie aktuelle Bedingungen für einen gespeicherten Standort ID von location.list/search oder explizite Koordinaten von city.search. Verwenden Sie forecast.get, wenn stündliche oder tägliche Prognosen erforderlich sind. Einheiten sind °C, km/h, mm, hPa und Meter.",
          input: {
            source: "Gespeicherter Standort oder explizite Koordinaten, die für die Vorhersage verwendet werden.",
          },
        },
        "forecast.get": {
          title: "Die Wettervorhersage abrufen",
          description:
            "Erhalten Sie aktuelle Bedingungen sowie stündliche und tägliche Aussichten für einen gespeicherten Standort ID von location.list/search oder explizite Koordinaten von city.search. Verwenden Sie forecast.current nur für aktuelle Bedingungen. Die Einheiten sind °C, km/h, mm und Sonnenscheinminuten.",
          input: {
            source: "Gespeicherter Standort oder explizite Koordinaten, die für die Vorhersage verwendet werden.",
          },
        },
        "location.list": {
          title: "Meine gespeicherten Wetterstandorte auflisten",
          description:
            "Normaler Eintrag zum Durchsuchen aller gespeicherten Orte. Verwenden Sie zurückgegebenes weather.location refs oder IDs mit location.read, forecast.current oder forecast.get. Verwenden Sie location.search, um nach Name oder Status zu filtern.",
          input: {
            limit: "Maximale Anzahl gespeicherter Orte, die zurückgegeben werden sollen.",
            cursor: "Undurchsichtiger Cursor, der von einem vorherigen location.list-Aufruf zurückgegeben wurde.",
          },
        },
        "location.read": {
          title: "Gespeicherten Wetterstandort lesen",
          description:
            "Lesen Sie einen weather.location ref, der von location.list, location.search oder location.create zurückgegeben wird.",
          input: {
            id: "Gespeicherter Ort ID, zurückgegeben von der Suche/Liste des gespeicherten Orts oder einem weather.location ref.",
          },
        },
        "location.search": {
          title: "Gespeicherten Wetterorten suchen",
          description:
            "Finden Sie einen eigenen gespeicherten Standort anhand des Namens oder Bundeslandes, wenn sein ID unbekannt ist. Verwenden Sie das zurückgegebene weather.location refs mit location.read, forecast.current oder forecast.get. Verwenden Sie city.search für nicht gespeicherte Orte.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            weather: {
              title: "Wetter",
              description: "Gespeicherte Wetterstandorte anzeigen.",
            },
          },
        },
      },
      actions: {
        "location.create": {
          title: "Wetterstandort speichern",
          description:
            "Speichern Sie einen Wetterstandort für den aktuellen Benutzer aus expliziten Koordinaten, die üblicherweise aus der Suche nach deutschen Städten kopiert werden.",
          input: {
            name: "Anzeigename; Kopieren Sie normalerweise den Namen aus dem ausgewählten Ergebnis der Suche nach deutschen Städten.",
            state:
              "Optionales Bundesland oder Region; Kopieren Sie normalerweise den Status aus dem Ergebnis der ausgewählten Stadt, sofern vorhanden.",
            lat: "Der Breitengrad wurde aus dem Ergebnis der ausgewählten Stadt oder einer anderen vertrauenswürdigen Koordinatenquelle kopiert.",
            lon: "Längengrad, kopiert aus dem Ergebnis der ausgewählten Stadt oder einer anderen vertrauenswürdigen Koordinatenquelle.",
          },
        },
        "location.delete": {
          title: "Gespeicherten Wetterstandort löschen",
          description: "Löschen Sie einen gespeicherten Wetterstandort, der dem aktuellen Benutzer gehört, dauerhaft.",
          input: {
            locationId: "Gespeicherter Ort ID, zurückgegeben von der Suche/Liste des gespeicherten Orts oder einem weather.location ref.",
          },
        },
      },
    },
  },
};
