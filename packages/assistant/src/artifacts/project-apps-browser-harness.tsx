import { render } from "solid-js/web";
import { AssistantProjectApps } from "../frontend/AssistantProjectApps";
import { AssistantProjectSkills } from "../frontend/AssistantProjectSkills";

const project = {
  id: "project1",
  shortId: "project1",
  name: "Project",
  description: "",
  instructions: "",
  icon: "",
  defaultModelProfileId: null,
  permission: location.pathname.includes("reader") ? ("read" as const) : ("admin" as const),
  revision: 1,
  createdAt: "",
  updatedAt: "",
};
render(
  () =>
    location.pathname.includes("skills") ? (
      <AssistantProjectSkills
        project={project}
        initialPage={{
          items: [
            {
              id: "app123",
              shortId: "app123",
              name: "Bank reconciliation",
              description: "Reconcile statements.",
              permission: project.permission,
              enabled: true,
              revision: 1,
              referenceCount: 0,
              createdAt: "",
              updatedAt: "",
            },
          ],
          page: 1,
          hasNext: false,
        }}
      />
    ) : (
      <AssistantProjectApps
        project={project}
        initialPage={{
          items: [
            {
              id: "app123",
              title: "Bank reconciliation",
              icon: "ti ti-app-window",
              published: true,
              canManage: project.permission === "admin",
              linked: true,
            },
          ],
          page: 1,
          hasNext: false,
        }}
      />
    ),
  document.getElementById("root")!,
);
