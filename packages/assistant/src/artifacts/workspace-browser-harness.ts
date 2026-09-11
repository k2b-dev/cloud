import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { ArtifactWorkspace, createArtifactWorkspace } from "./Workspace";
import { appTab } from "./workspace-state";

const id = "00000000-0000-4000-8000-000000000001";
render(() => {
  const controller = createArtifactWorkspace();
  controller.restore();
  if (!controller.state().tabs.length) controller.open(appTab(id, "Example"));
  if (new URL(location.href).searchParams.has("many")) for (let i = 0; i < 20; i++) controller.open({ kind: "view", key: `view-${i}`, title: `Long report number ${i}`, render: () => "Report" });
  return createComponent(ArtifactWorkspace, { controller, userId: id, refreshKey: "initial" });
}, document.getElementById("root")!);
