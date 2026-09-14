import { render } from "solid-js/web";
import Apps from "./Apps.island";
const draft = window.location.pathname === "/draft";
const item = { kind: "app" as const, id: "00000000-0000-4000-8000-000000000001", title: "Tip calculator", description: draft ? "" : "Calculate tips precisely.",
  revision: 2, publishedRevision: draft ? null : 1, permission: "admin" as const, updatedAt: new Date().toISOString(), forkedFromId: null, forkedFromRevision: null };
render(() => <Apps userId="test" conversations={[]} doneCount={0} projects={[]} initialList={{ items: [item], page: 1, hasNext: false }}
  initialApp={window.location.pathname.includes("/view") ? { ...item, sourceRevision: 2, source: { entry: "main.js", files: [] } } : undefined} />,
  document.getElementById("root")!);
