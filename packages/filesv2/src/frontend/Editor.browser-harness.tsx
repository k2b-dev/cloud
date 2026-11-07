import { derivePageTrail } from "@k2b/cloud/ssr/page-trail";
import { installPageSwap } from "@k2b/ssr/nav";
import { LocaleProvider, setPageTrail } from "@k2b/ui";
import { render } from "solid-js/web";
import { editorBases, editorDirectory, editorLaunch } from "./Editor.browser-fixtures";
import { snapshotTitle } from "./trail";
import Workspace from "./Workspace.island";
import type { WorkspaceSnapshot } from "./workspace-state";

// The real Files workspace as the Cloud shell hosts it: page swaps, the page trail, and the app's canvas.
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
installPageSwap();
const source = `${location.pathname}${location.search}`;
const params = new URL(source, location.origin).searchParams;
const file = params.get("view") === "edit" ? params.get("file") : null;
const initial: WorkspaceSnapshot = {
  source,
  bases: editorBases,
  selectedId: editorBases.items[0]!.id,
  directory: file ? null : editorDirectory(),
  editor: file ? editorLaunch(file) : undefined,
  errorCode: null,
};
setPageTrail(
  derivePageTrail(snapshotTitle(initial, "Files", { personal: "Personal", allStorage: "All storage" }, "en"), "/app/filesv2", "Files"),
);
render(
  () => (
    <LocaleProvider locale="en">
      <Workspace initial={initial} />
    </LocaleProvider>
  ),
  host,
);
