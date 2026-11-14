import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { AppWorkspace, installAppWorkspaceController, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import Workspace from "./Workspace.island";
import type { WorkspaceSnapshot } from "./workspace-state";

const host = document.getElementById("root");
const data = document.getElementById("snapshot");
const saved = document.getElementById("saved-layout");
if (!host || !data || !saved) throw new Error("Missing sidebar fixture");
const initial: WorkspaceSnapshot = JSON.parse(data.textContent!);
const state = JSON.parse(saved.textContent!);
layout.update({ breadcrumbs: [{ title: "Dateien", href: "/app/filesv2" }, { title: "Projektatelier" }] });
// As in Cloud: the layout restores the app's saved workspace cookie, and the shell owns one document controller.
document.body.setAttribute("data-k2b-app-workspace-controller", "global");
render(
  () => (
    <LocaleProvider locale="de">
      <AppWorkspace.LayoutStateProvider state={state}>
        <Workspace initial={initial} />
      </AppWorkspace.LayoutStateProvider>
    </LocaleProvider>
  ),
  host,
);
installAppWorkspaceController({ readState: () => state });
