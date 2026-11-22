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
      {/* Browser brings its head and columns, as in the workspace; a small sidebar stands beside them. */}
      <AppWorkspace mobileSurface="flush" class="filesv2-workspace">
        <AppWorkspace.Sidebar label="Storage" collapsible defaultSize={248}>
          <AppWorkspace.SidebarDesktop>
            <AppWorkspace.SidebarBody>
              <AppWorkspace.SidebarSection>
                <AppWorkspace.SidebarItem icon="ti ti-upload">Upload</AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem icon="ti ti-layout-grid">All storage</AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem icon="ti ti-history">Activity</AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem icon="ti ti-star">Favorites</AppWorkspace.SidebarItem>
              </AppWorkspace.SidebarSection>
              <AppWorkspace.SidebarSection title="Storage">
                <AppWorkspace.SidebarItem icon="ti ti-home">Personal</AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem icon="ti ti-users" active>
                  Office
                </AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem icon="ti ti-users">Workshop</AppWorkspace.SidebarItem>
              </AppWorkspace.SidebarSection>
            </AppWorkspace.SidebarBody>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        {directory() && (
          <Browser
            directory={directory()!}
            bases={[base]}
            source="/app/filesv2"
            uploads={uploads}
            selectionHint={new URLSearchParams(location.search).has("hint")}
            error={new URLSearchParams(location.search).has("error") ? "The folder could not be loaded again." : undefined}
            onRetry={() => host.setAttribute("data-retried", "true")}
            onShare={(paths) => host.setAttribute("data-shared", JSON.stringify(paths))}
            onChanged={async () => {
              setDirectory(await listing());
            }}
            onNavigate={async () => {}}
          />
        )}
      </AppWorkspace>
    </LocaleProvider>
  );
}, host);
