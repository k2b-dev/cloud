import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const mapViewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      mapLabel: "Map",
      summary: ({ count }: { count: number }) => `Map with ${count} ${count === 1 ? "place" : "places"}`,
      pins: "Places on the map",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      locate: "Show my location",
      loading: "Loading map …",
      error: "Map image did not load. The pins stay.",
      retry: "Try again",
      noWebgl: "This browser cannot show the map image. The pins stay.",
      ownLocation: "Your location",
      canvasTitle: "Map. Arrow keys move it.",
      gestureWindows: "Use Ctrl + scroll to zoom the map",
      gestureMac: "Use ⌘ + scroll to zoom the map",
      gestureMobile: "Use two fingers to move the map",
    },
    de: {
      mapLabel: "Karte",
      summary: ({ count }) => `Karte mit ${count} ${count === 1 ? "Ort" : "Orten"}`,
      pins: "Orte auf der Karte",
      zoomIn: "Vergrößern",
      zoomOut: "Verkleinern",
      locate: "Ich bin hier",
      loading: "Karte lädt …",
      error: "Kartenbild nicht geladen, die Pins bleiben.",
      retry: "Erneut versuchen",
      noWebgl: "Dieser Browser kann das Kartenbild nicht zeigen, die Pins bleiben.",
      ownLocation: "Dein Standort",
      canvasTitle: "Karte. Pfeiltasten verschieben sie.",
      gestureWindows: "Strg + Scrollen zoomt die Karte",
      gestureMac: "⌘ + Scrollen zoomt die Karte",
      gestureMobile: "Mit zwei Fingern verschieben",
    },
  },
});
export const useMapViewMessages = () => {
  const locale = useLocale();
  return () => mapViewMessages.resolve([locale()]).t;
};
export const checkMapViewMessages = () => mapViewMessages.check();
