import { LocaleProvider, Tag } from "@k2b/ui";
import { render } from "solid-js/web";
import AgentPictureTrigger from "./AgentPictureTrigger.island";

/** The head of an agent's page for a browser test, which answers the administration API itself. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <div class="flex min-w-0 items-center gap-4 py-2">
        <AgentPictureTrigger id="0b2f5c7e-0000-4000-8000-0000000000bb" name="Festplaner" avatarHash={null} />
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-xl font-semibold tracking-tight text-primary">Festplaner</h1>
          <div class="mt-2">
            <Tag>Agent</Tag>
          </div>
        </div>
      </div>
    </LocaleProvider>
  ),
  host,
);
