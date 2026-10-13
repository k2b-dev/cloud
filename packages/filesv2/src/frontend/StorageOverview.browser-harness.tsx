import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { BaseSummary, MarkedEntry } from "../contracts";
import StorageOverview from "./StorageOverview";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const bases: BaseSummary[] = ["valentin", "accounts", "projects", "archive", "missing"].map((name, index) => ({
  id: name,
  name,
  kind: index === 0 ? "users" : "groups",
  area: index < 3 ? "cloud" : "freeipa",
  status: index === 4 ? "missing" : "existing",
  reason: index === 4 ? "missing" : null,
  indexEnabled: false,
  versioningEnabled: false,
}));
const recent: MarkedEntry[] = ["Notes.md", "Notes.md", "Plan.txt"].map((name, index) => ({
  base: bases[index]!,
  entry: { name, path: `Docs/${name}`, directory: false, size: 0, modified: "2026-10-01T00:00:00Z" },
  markedAt: `2026-10-0${index + 1}T00:00:00Z`,
}));
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          <StorageOverview
            bases={bases}
            issues={[]}
            recent={recent}
            onOpenRecent={(item) => host.setAttribute("data-opened", item.entry.path)}
            onNavigate={(event) => host.setAttribute("data-navigated", `${event.url.pathname}${event.url.search}`)}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  host,
);
