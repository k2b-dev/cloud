import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { BaseSummary } from "../contracts";
import { openDestinationDialog } from "./MoveDialog";

// Fictional data only.
const base: BaseSummary = {
  id: "cloud:groups:6f0c2a1e-3b7d-4e55-9a10-2c4d8e9f7b21",
  area: "cloud",
  kind: "groups",
  name: "Projekt Sommerfest",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
};

declare global {
  interface Window {
    openPicker: () => void;
    picked?: unknown;
  }
}

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(() => <LocaleProvider locale="en">{null}</LocaleProvider>, host);
window.openPicker = () => {
  void openDestinationDialog({ bases: [base], sourceBaseId: base.id, sourcePaths: ["Offer.pdf"], initialFolder: "" }).then((value) => {
    window.picked = value;
  });
};
