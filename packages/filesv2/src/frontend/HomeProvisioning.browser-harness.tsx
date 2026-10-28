import { AppWorkspace, LocaleProvider, SettingsPage } from "@k2b/ui";
import { render } from "solid-js/web";
import type { HomeProvisioningOverview, HomeProvisioningStatus } from "../contracts";
import HomeProvisioning from "./HomeProvisioning";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const user = (index: number, state: HomeProvisioningStatus["state"], errorCode: string | null = null): HomeProvisioningStatus => ({
  userId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  username: ["ada", "grace", "linus", "margaret", "ken"][index % 5]!,
  area: "freeipa",
  state,
  operationId: null,
  eventId: null,
  errorCode,
  updatedAt: "2026-10-27T09:30:00Z",
});
const reconcile = { lastRunAt: "2026-10-27T09:00:00Z", lastResult: { processed: 40, done: 37, pending: 2, failed: 1 }, running: false };
const scenarios: Record<string, HomeProvisioningOverview> = {
  waiting: {
    area: "freeipa",
    counts: { done: 37, posix_incomplete: 1, auto_create_off: 1, failed: 1 },
    items: [user(0, "posix_incomplete"), user(1, "auto_create_off"), user(2, "failed", "path_conflict")],
    nextCursor: "00000000-0000-4000-8000-000000000002",
    reconcile,
  },
  done: { area: "cloud", counts: { done: 12 }, items: [], nextCursor: null, reconcile: { ...reconcile, running: true } },
  empty: { area: "cloud", counts: {}, items: [], nextCursor: null, reconcile: { lastRunAt: null, lastResult: null, running: false } },
  unconfigured: {
    area: "cloud",
    counts: { not_configured: 2 },
    items: [user(3, "not_configured"), user(4, "not_configured")],
    nextCursor: null,
    reconcile: { lastRunAt: null, lastResult: null, running: false },
  },
};
const overview = scenarios[location.hash.slice(1)] ?? scenarios.waiting!;
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          <SettingsPage title="Overview">
            <HomeProvisioning
              overview={overview}
              settingsHref="/admin/filesv2?view=settings"
              onNavigate={(event) => host.setAttribute("data-navigated", `${event.url.pathname}${event.url.search}`)}
            />
          </SettingsPage>
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  ),
  host,
);
