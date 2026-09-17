import type { AiProject } from "@k2b/cloud/ai";
import { artifactClient } from "../artifacts/client";
import { AssistantProjectLinks } from "./AssistantProjectLinks";
import { useAssistantText } from "./ui-copy";

type AppPage = Awaited<ReturnType<typeof artifactClient.projectApps>>;
export function AssistantProjectApps(props: { project: AiProject; initialPage: AppPage }) {
  const text = useAssistantText();
  const page = (value: AppPage) => ({ ...value, items: value.items.map(app => ({ ...app,
    description: app.published ? undefined : text("Draft — publish before members can use it.") })) });
  return <AssistantProjectLinks icon="ti ti-app-window" project={props.project} initialPage={page(props.initialPage)}
    title={text("Studio Apps")} addLabel={text("Link a Studio App")} searchLabel={text("Search Studio Apps…")}
    notice={text("Members can use linked, published apps and their shared app data. Editing permissions stay unchanged.")}
    emptyLabel={text("No linked apps yet.")} noResultsLabel={text("No matching apps that you manage.")}
    load={async (cursor, query, available, signal) => page(await artifactClient.projectApps(props.project.id,cursor,query,available,signal))}
    change={(id,linked) => artifactClient.linkProject(id,props.project.id,linked)} />;
}
