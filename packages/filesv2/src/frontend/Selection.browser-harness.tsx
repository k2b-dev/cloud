import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { BaseSummary } from "../contracts";
import Browser from "./Browser";
import { createFilesUploads } from "./files-uploads";
import type { DirectoryView } from "./workspace-state";

// The real Browser on one invented folder; the test serves its listing, previews and PDF actions.
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const base: BaseSummary = {
  id: "cloud:groups:3f0c1e8a-2b7d-4c55-9a1e-5d2f8b6c7a90",
  locationKey: "buero",
  area: "cloud",
  kind: "groups",
  name: "Büro",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: false,
};
const listing = async (): Promise<DirectoryView> => ({
  base,
  path: "Angebote 2026",
  items: await (await fetch("/harness/items")).json(),
  next: null,
});
render(() => {
  const uploads = createFilesUploads();
  const [directory, setDirectory] = createSignal<DirectoryView | null>(null);
  void listing().then(setDirectory);
  return (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          {directory() && (
            <Browser
              directory={directory()!}
              bases={[base]}
              source="/app/filesv2"
              uploads={uploads}
              selectionPillHint={new URLSearchParams(location.search).has("hint")}
              onShare={(paths) => host.setAttribute("data-shared", JSON.stringify(paths))}
              onChanged={async () => setDirectory(await listing())}
              onNavigate={async () => {}}
            />
          )}
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}, host);
