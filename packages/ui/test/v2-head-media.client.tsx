import { render } from "solid-js/web";
import Folder from "../skills/k2b-ui/recipes/files";
import SigninSettings from "../skills/k2b-ui/recipes/settings-page";
import { LocaleProvider } from "../src/intl/locale";
import { AreasMenuScreen, CanvasFillScreen, DeepPathScreen, LongAddressScreen, RowStatesScreen } from "./v2-row-states.fixture";

// The folder and the settings page of the k2b-ui skill in the browser, by the case the page names before this bundle
// runs: the list with the open file, the grid, the grid with three photos selected, or the settings page.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?:
      | "list"
      | "grid"
      | "selecting"
      | "settings"
      | "states"
      | "canvas"
      | "path"
      | "split-canvas"
      | "split-list-canvas"
      | "long"
      | "areas";
    /** The height of the drawing right after the first render, before anything could measure it. */
    __k2FirstCanvas?: number;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("head-media: #root is missing");
const which = window.__k2Case ?? "list";
render(
  () => (
    // the recipes write German sample text, so the library's own words are German too
    <LocaleProvider locale="de">
      {which === "settings" ? (
        <SigninSettings />
      ) : which === "states" ? (
        <RowStatesScreen />
      ) : which === "areas" ? (
        <AreasMenuScreen />
      ) : which === "long" ? (
        <LongAddressScreen />
      ) : which === "path" ? (
        <DeepPathScreen />
      ) : which === "canvas" || which === "split-canvas" || which === "split-list-canvas" ? (
        <CanvasFillScreen split={which !== "canvas"} list={which === "split-list-canvas"} />
      ) : (
        <Folder grid={which !== "list"} selected={which === "selecting" ? ["front", "vorher", "granit"] : undefined} />
      )}
    </LocaleProvider>
  ),
  root,
);
// read synchronously after the first render: a drawing that fills its pane has its height before any script measures
const canvas = document.querySelector<HTMLElement>(".k2-canvas[data-fill]");
if (canvas) window.__k2FirstCanvas = canvas.getBoundingClientRect().height;
window.__k2Mounted = true;
