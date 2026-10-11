import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const viewportMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      resetZoom: "Reset zoom",
      openFullscreen: "Open fullscreen",
      zoomPanKeys: "Zoom with plus and minus, move with the arrow keys, reset with 0, open fullscreen with F.",
    },
    de: {
      zoomIn: "Vergrößern",
      zoomOut: "Verkleinern",
      resetZoom: "Zoom zurücksetzen",
      openFullscreen: "Im Vollbild öffnen",
      zoomPanKeys: "Mit Plus und Minus zoomen, mit den Pfeiltasten verschieben, mit 0 zurücksetzen, mit F im Vollbild öffnen.",
    },
  },
});

export type ViewportMessages = ReturnType<(typeof viewportMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useViewportMessages = (): (() => ViewportMessages) => {
  const locale = useLocale();
  return () => viewportMessages.resolve([locale()]).t;
};

export const checkViewportMessages = () => viewportMessages.check();
