import { AppOverview, LocaleProvider } from "@k2b/ui";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import { ToolsWorkspace } from "./ToolsWorkspace";
import HashGenerator from "./tools/HashGenerator.island";
import { registryMessages } from "./tools/registry";
import WebhookTester from "./tools/WebhookTester.island";

const params = new URL(location.href).searchParams;
const locale = params.get("lang") === "en" ? "en" : "de";
const labels = registryMessages.resolve([locale]).t;
const view = params.get("view");
if (view === "webhooks") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.startsWith("/tools/api/webhooks/")) return originalFetch(input, init);
    if (params.get("state") === "error") return Promise.resolve(Response.json({ message: "Testverbindung unterbrochen" }, { status: 503 }));
    return Promise.resolve(
      Response.json({
        items:
          params.get("state") === "empty"
            ? []
            : url.pathname.endsWith("/endpoints")
              ? [
                  {
                    id: "00000000-0000-4000-8000-000000000001",
                    token: "fixture",
                    name: "Bestellungen",
                    urlPath: "/tools/webhooks/fixture",
                    requestCount: 12,
                    lastRequestAt: "2026-11-07T10:00:00Z",
                    createdAt: "2026-11-01T10:00:00Z",
                  },
                ]
              : [],
      }),
    );
  }, originalFetch);
}
render(
  () => (
    <LocaleProvider locale={locale}>
      <ToolsWorkspace activeToolId={view ?? undefined} layout={view === "webhooks" ? "regions" : "main"}>
        <Show
          when={view === "webhooks"}
          fallback={
            <Show
              when={view === "hash"}
              fallback={
                <AppOverview title={labels.appName} icon="ti ti-tools">
                  <AppOverview.Main title={locale === "de" ? "Passendes Werkzeug finden" : "Find a utility"}>
                    <ToolCatalog initialQuery={params.get("q") ?? ""} />
                  </AppOverview.Main>
                </AppOverview>
              }
            >
              <div class="mx-auto flex w-full max-w-5xl flex-col gap-4">
                <h1 class="text-xl font-semibold">{labels.hashName}</h1>
                <HashGenerator />
              </div>
            </Show>
          }
        >
          <WebhookTester baseHref="/tools/webhooks" />
        </Show>
      </ToolsWorkspace>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
