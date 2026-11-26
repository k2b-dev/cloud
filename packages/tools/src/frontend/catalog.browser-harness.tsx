import { LocaleProvider } from "@k2b/ui";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import { ToolsWorkspace } from "./ToolsWorkspace";
import HashGenerator from "./tools/HashGenerator.island";
import { registryMessages } from "./tools/registry";

const params = new URL(location.href).searchParams;
const locale = params.get("lang") === "en" ? "en" : "de";
const labels = registryMessages.resolve([locale]).t;
const view = params.get("view");
render(
  () => (
    <LocaleProvider locale={locale}>
      <Show
        when={view === "hash"}
        // The catalog is a v2 screen: it brings the Tools frame itself.
        fallback={<ToolCatalog search={params.get("q") ?? ""} />}
      >
        <ToolsWorkspace activeToolId={view ?? undefined} layout="main">
          <div class="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <h1 class="text-xl font-semibold">{labels.hashName}</h1>
            <HashGenerator />
          </div>
        </ToolsWorkspace>
      </Show>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
