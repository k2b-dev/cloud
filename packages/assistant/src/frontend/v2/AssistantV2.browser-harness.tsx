import LayoutHeader from "@k2b/cloud/ssr/LayoutHeader";
import LayoutRail from "@k2b/cloud/ssr/LayoutRail";
import { type ShellData, ShellDataProvider } from "@k2b/cloud/ssr/shell-data";
import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import { render } from "solid-js/web";
import AssistantWorkspace from "../AssistantWorkspace.island";

declare global {
  interface Window {
    // Named after this test: test clients share one ui and assistant typecheck, where two globals of one name clash.
    assistantV2Harness: { locale: string; props: ComponentProps<typeof AssistantWorkspace> };
    assistantV2Searches: unknown[];
  }
}

// The page as Cloud's Layout draws it around a v2 app: the rail of apps, the phone's bar and the app area, whose main
// is the v2 scope. Shell data is invented; the workspace gets the props the server would render.
const app = (id: string, label: string, icon: string, accent: string) => ({
  id,
  iconClass: `ti ti-${icon}`,
  label,
  href: `/app/${id}`,
  match: `/app/${id}`,
  defaultVisible: true,
  accent,
});
const shell: ShellData = {
  apps: [
    app("assistant", "Gustav", "moustache", "#8e1b6f"),
    app("mail", "Mail", "mail", "#2563eb"),
    app("filesv2", "Dateien", "folder", "#0f766e"),
    app("spaces", "Spaces", "layout-kanban", "#7c3aed"),
    app("notebooks", "Notizbücher", "notebook", "#b45309"),
    app("grids", "Grids", "table", "#15803d"),
  ],
  rail: { revision: 1, visibility: {}, shortcuts: [], showNames: false },
  legalLinks: [],
  profile: { userId: "user-mira", name: "Mira Sander" },
  theme: "light",
  searchLinks: {},
  appId: "assistant",
};
// The shell's search host, as ShellRuntime registers it: the test reads which search the page asked for.
window.assistantV2Searches = [];
window.addEventListener("cloud.search.open", (event) => {
  const request = (event as CustomEvent<{ options: unknown; accepted: boolean }>).detail;
  request.accepted = true;
  window.assistantV2Searches.push(request.options);
});
render(
  () => (
    <LocaleProvider locale={window.assistantV2Harness.locale}>
      <ShellDataProvider data={shell} skipScript>
        <div
          class="cloud-app-canvas relative flex h-dvh w-full overflow-hidden"
          data-app-id="assistant"
          data-layout-full-page="true"
          data-layout-authenticated="true"
        >
          <LayoutRail currentPath={location.pathname} name="Cloud" />
          <div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col" data-cloud-app-area="">
            <LayoutHeader authenticated launchpad title="Gustav" />
            <main
              class="layout-content-main min-h-0 min-w-0 flex-1 flex flex-col k2-ui"
              // As Cloud's Layout ui="v2" with the rail: the shell's phone bar holds the page's one search.
              data-k2-host-search=""
            >
              <AssistantWorkspace {...window.assistantV2Harness.props} />
            </main>
          </div>
        </div>
      </ShellDataProvider>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
document.body.dataset.ready = "true";
