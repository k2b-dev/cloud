import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { BaseSummary } from "../contracts";
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
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          <StorageOverview
            bases={bases}
            issues={[]}
            favorites={undefined}
            env={{
              now: "2026-10-20T12:30:00.000Z",
              timeZone: "Europe/Berlin",
              onNavigate: (event) => host.setAttribute("data-navigated", `${event.url.pathname}${event.url.search}`),
            }}
            onNavigate={(event) => host.setAttribute("data-navigated", `${event.url.pathname}${event.url.search}`)}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  host,
);
