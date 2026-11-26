import { render } from "solid-js/web";
import Folder from "../skills/k2b-ui/recipes/files";
import SigninSettings from "../skills/k2b-ui/recipes/settings-page";
import { LocaleProvider } from "../src/intl/locale";
import {
  AreasMenuScreen,
  CanvasFillScreen,
  CellsScreen,
  DeepPathScreen,
  DialogInlineScreen,
  EmptyWaysScreen,
  FactsScreen,
  GroupsScreen,
  LongAddressScreen,
  ProseCodeScreen,
  RowStatesScreen,
  SectionFootScreen,
  SelectionScreen,
  StructureScreen,
  ViewStatementScreen,
} from "./v2-row-states.fixture";

// The folder and the settings page of the k2b-ui skill in the browser, by the case the page names before this bundle
// runs: the list with the open file, the grid, the grid with three photos selected, or the settings page.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?:
      | "list"
      | "closed"
      | "grid"
      | "selecting"
      | "settings"
      | "states"
      | "canvas"
      | "cells"
      | "cells-narrow"
      | "path"
      | "path-chip"
      | "split-canvas"
      | "selection"
      | "long"
      | "areas"
      | "structure"
      | "prose"
      | "groups"
      | "split-list-canvas"
      | "empty-ways"
      | "view-statement"
      | "section-foot"
      | "facts"
      | "dialog-inline";
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
      ) : which === "prose" ? (
        <ProseCodeScreen />
      ) : which === "groups" ? (
        <GroupsScreen />
      ) : which === "structure" ? (
        <StructureScreen />
      ) : which === "areas" ? (
        <AreasMenuScreen />
      ) : which === "empty-ways" ? (
        <EmptyWaysScreen />
      ) : which === "selection" ? (
        <SelectionScreen />
      ) : which === "dialog-inline" ? (
        <DialogInlineScreen />
      ) : which === "facts" ? (
        <FactsScreen />
      ) : which === "section-foot" ? (
        <SectionFootScreen />
      ) : which === "view-statement" ? (
        <ViewStatementScreen />
      ) : which === "long" ? (
        <LongAddressScreen />
      ) : which === "path" || which === "path-chip" ? (
        <DeepPathScreen chip={which === "path-chip"} />
      ) : which === "canvas" || which === "split-canvas" || which === "split-list-canvas" ? (
        <CanvasFillScreen split={which !== "canvas"} list={which === "split-list-canvas"} />
      ) : which === "cells" || which === "cells-narrow" ? (
        <CellsScreen narrow={which === "cells-narrow"} />
      ) : (
        <Folder
          closed={which === "closed"}
          grid={which !== "list" && which !== "closed"}
          selected={which === "selecting" ? ["front", "vorher", "granit"] : undefined}
        />
      )}
    </LocaleProvider>
  ),
  root,
);
// read synchronously after the first render: a drawing that fills its pane has its height before any script measures
const canvas = document.querySelector<HTMLElement>(".k2-canvas[data-fill]");
if (canvas) window.__k2FirstCanvas = canvas.getBoundingClientRect().height;
window.__k2Mounted = true;
