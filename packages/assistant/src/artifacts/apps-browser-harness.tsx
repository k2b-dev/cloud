import { render } from "solid-js/web";
import Apps from "./Apps.island";

const draft = window.location.pathname === "/draft";
const item = {
  kind: "app" as const,
  id: "00000000-0000-4000-8000-000000000001",
  title: "Tip calculator",
  description: draft ? "" : "Calculate tips precisely.",
  revision: 2,
  publishedRevision: draft ? null : 1,
  permission: window.location.pathname === "/reader" ? ("read" as const) : ("admin" as const),
  updatedAt: new Date().toISOString(),
  forkedFromId: null,
  forkedFromRevision: null,
};
render(
  () => (
    <Apps
      userId="test"
      conversations={[]}
      doneCount={0}
      projects={[]}
      initialApp={{ ...item, sourceRevision: 2, source: { entry: "main.js", files: [] } }}
    />
  ),
  document.getElementById("root")!,
);
