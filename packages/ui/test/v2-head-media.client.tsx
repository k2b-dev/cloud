import { render } from "solid-js/web";
import Folder from "../skills/k2b-ui/recipes/files";
import SigninSettings from "../skills/k2b-ui/recipes/settings-page";
import { LocaleProvider } from "../src/intl/locale";

// The folder and the settings page of the k2b-ui skill in the browser, by the case the page names before this bundle
// runs: the list with the open file, the grid, the grid with three photos selected, or the settings page.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Case?: "list" | "grid" | "selecting" | "settings";
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
      ) : (
        <Folder grid={which !== "list"} selected={which === "selecting" ? ["front", "vorher", "granit"] : undefined} />
      )}
    </LocaleProvider>
  ),
  root,
);
window.__k2Mounted = true;
