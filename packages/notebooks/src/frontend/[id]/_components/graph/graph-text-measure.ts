import { createSignal, onCleanup, onMount } from "solid-js";
import type { LabelFont } from "./labels";

/** Every weight the labels and headings use. */
const LABEL_WEIGHTS = [400, 600, 700];

/**
 * Measure the actual canvas font only after its faces have loaded; cache for this mounted display. A browser loads a
 * face only once text uses it, so `document.fonts.ready` alone can resolve while the bold face of the current note's
 * label is still missing, and the canvas would measure a fallback font. The faces are loaded explicitly first.
 */
export function createGraphTextMeasure(svg: () => SVGSVGElement) {
  const [ready, setReady] = createSignal(false);
  let context: CanvasRenderingContext2D | null = null;
  let family = "sans-serif";
  const widths = new Map<string, number>();
  onMount(() => {
    let alive = true;
    onCleanup(() => {
      alive = false;
    });
    family = getComputedStyle(svg()).fontFamily || family;
    const faces = LABEL_WEIGHTS.map((weight) => document.fonts.load(`${weight} 12px ${family}`).catch(() => []));
    void Promise.all(faces)
      .then(() => document.fonts.ready)
      .then(() => {
        if (!alive) return;
        context = document.createElement("canvas").getContext("2d");
        setReady(true);
      });
  });
  const measure = (text: string, font: LabelFont) => {
    const key = `${font.weight}|${font.size}|${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      if (!context) return text.length * font.size * 0.6;
      context.font = `${font.weight} ${font.size}px ${family}`;
      width = context.measureText(text).width;
      widths.set(key, width);
    }
    return width;
  };
  return { ready, measure };
}
