import { i18n } from "@k2b/stdlib";
import { files } from "@k2b/stdlib/browser";
import { toast, useLocale, ZoomPanViewport } from "@k2b/ui";
import type { JSX } from "solid-js";
import { diagramBackground, diagramFilename, pngScale, rasterizeSvg, standaloneSvg } from "./mermaid-export";

export const mermaidViewportMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      diagram: "Diagram",
      downloadSvg: "Download SVG",
      downloadPng: "Download PNG",
      exportFailed: "The diagram could not be exported.",
    },
    de: {
      diagram: "Diagramm",
      downloadSvg: "SVG herunterladen",
      downloadPng: "PNG herunterladen",
      exportFailed: "Das Diagramm konnte nicht exportiert werden.",
    },
  },
});

export type MermaidViewportProps = {
  /** Returns a new diagram node on every call: once inline, once per fullscreen opening. */
  diagram: () => JSX.Element;
  /** Note title for the fullscreen heading and the export file names. */
  title?: string | null;
  /** Rendered Mermaid SVG markup without HTML labels, so it can be rasterized. */
  exportSvg: () => string | Promise<string>;
  controls?: "visible" | "hover";
  class?: string;
};

/** A Mermaid diagram that can be zoomed, panned, opened fullscreen, and exported as SVG or PNG. */
export function MermaidViewport(props: MermaidViewportProps): JSX.Element {
  const locale = useLocale();
  const t = () => mermaidViewportMessages.resolve([locale()]).t;
  const exporting = (format: "svg" | "png") => async () => {
    try {
      const diagram = standaloneSvg(await props.exportSvg());
      if (format === "svg") {
        files.downloadFileFromContent(diagram.svg, `${diagramFilename(props.title)}.svg`, "image/svg+xml");
        return;
      }
      const dark = document.documentElement.classList.contains("dark");
      const png = await rasterizeSvg(diagram, {
        background: diagramBackground(dark),
        scale: pngScale(diagram.width, diagram.height, window.devicePixelRatio || 1),
      });
      files.downloadFileFromContent(png, `${diagramFilename(props.title)}.png`, "image/png");
    } catch (error) {
      console.error("Mermaid export failed", error);
      toast.error(t().exportFailed);
    }
  };
  return (
    <ZoomPanViewport
      class={props.class}
      label={t().diagram}
      controls={props.controls}
      fullscreen={{
        title: props.title?.trim() || t().diagram,
        content: props.diagram,
        actions: [
          { label: t().downloadSvg, icon: "ti ti-file-vector", onSelect: exporting("svg") },
          { label: t().downloadPng, icon: "ti ti-photo-down", onSelect: exporting("png") },
        ],
      }}
    >
      {props.diagram()}
    </ZoomPanViewport>
  );
}
