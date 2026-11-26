import { LocaleProvider } from "@k2b/ui";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import HashGenerator from "./tools/HashGenerator.island";

const params = new URL(location.href).searchParams;
const locale = params.get("lang") === "en" ? "en" : "de";
const view = params.get("view");
render(
  () => (
    <LocaleProvider locale={locale}>
      <Show
        when={view === "hash"}
        // The catalog is a v2 screen: it brings the Tools frame itself.
        fallback={<ToolCatalog search={params.get("q") ?? ""} />}
      >
        <HashGenerator />
      </Show>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
