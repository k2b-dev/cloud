import { PWA_CANVAS_COLORS, PWA_V2_HEAD_COLORS } from "./pwa";

/** Below 768 px the v2 frame's head reaches the status bar; from 768 px the rail's canvas does (`pwa-layout.css`). */
const PHONE = "not all and (min-width: 768px)";
const WIDE = "(min-width: 768px)";

type Theme = "light" | "dark";

/**
 * The status bar and the document's ground of a v2 app page (`PwaLayout ui="v2"`): the head's colour on the phone,
 * the canvas from 768 px, in one theme or, without one, in both system themes. The server writes them before any
 * stylesheet; the page's runtime writes them again when the person changes the theme.
 */
export const pwaFrameColors = (theme: Theme | undefined) => {
  const themes: readonly Theme[] = theme ? [theme] : ["light", "dark"];
  const scheme = (each: Theme) => (theme ? "" : ` and (prefers-color-scheme: ${each})`);
  const metas = themes.flatMap((each) => [
    { media: `${PHONE}${scheme(each)}`, content: PWA_V2_HEAD_COLORS[each] },
    { media: `${WIDE}${scheme(each)}`, content: PWA_CANVAS_COLORS[each] },
  ]);
  const ground = (each: Theme) =>
    `html{background-color:${PWA_V2_HEAD_COLORS[each]}}@media ${WIDE}{html{background-color:${PWA_CANVAS_COLORS[each]}}}`;
  const css = theme ? ground(theme) : `${ground("light")}@media (prefers-color-scheme: dark){${ground("dark")}}`;
  return { metas, css };
};
