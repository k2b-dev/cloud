import { render } from "solid-js/web";
import AssistantEmptyChat from "../frontend/AssistantEmptyChat";
import Apps from "./Apps.island";
import { ArtifactStorage } from "./runtime/storage";

const source = {
  entry: "main.ts",
  files: [
    { path: "main.ts", content: 'export default () => { ui.text({value:"Hello"}); };' },
    { path: "other.ts", content: "export const amount = 10;" },
  ],
};
const id = "00000000-0000-4000-8000-000000000001";
const item = {
  kind: "app" as const,
  id,
  title: "Advanced fixture",
  description: "",
  revision: 1,
  publishedRevision: 1,
  permission: location.search.includes("reader") ? ("read" as const) : ("admin" as const),
  updatedAt: new Date().toISOString(),
  forkedFromId: null,
  forkedFromRevision: null,
};
const view = location.pathname.endsWith("/edit") ? "edit" : location.pathname.endsWith("/database") ? "database" : "app";
render(
  () =>
    location.pathname === "/starters" ? (
      <AssistantEmptyChat
        composer={<div>Ask the Assistant</div>}
        projects={[]}
        selectedProjectId={null}
        onChooseProject={() => {}}
        onStarter={() => {}}
      />
    ) : (
      <Apps
        userId="test"
        conversations={[]}
        doneCount={0}
        projects={[]}
        initialApp={{ ...item, source, sourceRevision: 1 }}
        view={view}
        databaseStatus={{ configured: true, connected: true, overview: null, unavailable: null, generation: null, dataRevision: null }}
      />
    ),
  document.getElementById("root")!,
);
if (location.pathname === "/reader") {
  void new ArtifactStorage("test", id).call("store.set", ["local-fixture", 42]);
  void new ArtifactStorage("someone-else", id).call("store.set", ["private-fixture", 99]);
}
