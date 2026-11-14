import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import Workspace from "./Workspace.island";
import type { WorkspaceSnapshot } from "./workspace-state";

const host = document.getElementById("root");
const data = document.getElementById("snapshot");
if (!host || !data) throw new Error("Missing pagination fixture");
const initial: WorkspaceSnapshot = JSON.parse(data.textContent!);
layout.update({ breadcrumbs: [{ title: "Dateien", href: "/app/filesv2" }, { title: "Projektatelier" }] });
render(
  () => (
    <LocaleProvider locale="de">
      <Workspace initial={initial} />
    </LocaleProvider>
  ),
  host,
);
