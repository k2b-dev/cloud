import { createArtifactActions } from "./artifact-actions";
import { StudioCard } from "./StudioCard";
import { AppWorkspace, Button, Dropdown, Placeholder, useLocale } from "@k2b/ui";
import { navigateTo } from "@k2b/ssr/nav";
import { createSignal, For, Show } from "solid-js";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import type { ArtifactBundle, artifacts } from "./service";
import AssistantSidebar from "../frontend/AssistantSidebar";
import { AssistantLiveProvider, createAssistantLiveInvalidationHub } from "../frontend/assistant-live";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { ArtifactPanel } from "./ArtifactPanel";
import { assistantApi } from "../api/client";
import { openAssistantCreateProjectDialog } from "../frontend/AssistantProjectsDialog";
import { ManualEditor } from "./ManualEditor";
import { SqlConsole } from "./SqlConsole";

type Props = { userId: string; doneCount: number; conversations: AiConversation[]; projects: AiProject[];
  initialList: Awaited<ReturnType<typeof artifacts.list>>; initialApp?: ArtifactBundle;
  view?:"app"|"edit"|"database"; selectedFile?:string;
  databaseStatus?:Awaited<ReturnType<typeof artifactClient.databaseStatus>> };

export default function Apps(props: Props) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const live = createAssistantLiveInvalidationHub({ onApplied: () => {} });
  const [sidebar, setSidebar] = createSignal({ conversations: props.conversations, projects: props.projects, doneCount: props.doneCount });
  const reloadSidebar = async () => setSidebar(await assistantApi.loadSidebar());
  const [selectedVersion, setSelectedVersion] = createSignal<number>();
  const page = () => props.initialList.page;
  const [list, setList] = createSignal(props.initialList);
  const reloadList = async () => setList(await artifactClient.list(page()));
  const setPage = (next: (page: number) => number) => navigateTo(`/app/assistant/apps?page=${next(page())}`);
  const [app, setApp] = createSignal(props.initialApp);
  const [editorDirty,setEditorDirty]=createSignal(false);
  const { menu, action, busy, error, publish, versions } = createArtifactActions({
    userId: props.userId, projects: props.projects, refresh: reloadList, app, setApp, editorDirty, setSelectedVersion, view: props.view,
  });
  const open = (id: string) => navigateTo(`/app/assistant/apps/${id}`);
  return <AssistantLiveProvider value={live}><AppWorkspace class="flex-1 min-h-0">
    <AssistantSidebar conversations={() => sidebar().conversations} doneCount={sidebar().doneCount} projects={sidebar().projects} onConversationUpdated={() => void reloadSidebar()} onConversationArchived={() => void reloadSidebar()} activeView="apps" live={live}
      creatingConversation={busy}
      onNewConversation={() => action(async () => navigateTo(`/app/assistant?conversation=${(await assistantApi.createConversation()).shortId}`))}
      onCreateProject={async () => { const project = await openAssistantCreateProjectDialog(); if (project) navigateTo(`/app/assistant?project=${project.id}`); }} />
    <AppWorkspace.Content><AppWorkspace.Main scroll={!app()}>
      <div class="assistant-apps-page" classList={{ "assistant-apps-page--runner": !!app() }}>
        <Show when={app()} fallback={<>
          <h1 class="text-xl font-semibold">{t().apps}</h1>
          <Show when={error()}><Placeholder state="error" title={t().REQUEST_FAILED} description={error()} /></Show>
              <Show when={list()?.items.length} fallback={<Placeholder title={t().noAccessibleApps} />}>
                <div class="assistant-apps-grid"><For each={list()?.items}>{item =>
                  <StudioCard item={item} menu={menu(item)} busy={busy()} onStart={() => open(item.id)} />
                }</For></div>
              </Show>
              <Show when={page() > 1 || list()?.hasNext}>
                <div class="flex gap-2"><Button variant="secondary" disabled={page() === 1} onClick={() => setPage(p => p - 1)}>{t().back}</Button>
                  <Button variant="secondary" disabled={!list()?.hasNext} onClick={() => setPage(p => p + 1)}>{t().next}</Button></div>
              </Show>
        </>}>
          {selected => <>
            <div class="assistant-studio-runner-header">
              <h1><i class={selected().icon??"ti ti-app-window"}/>{selected().title}</h1>
              <div class="flex gap-2">
                <Dropdown.Root items={menu(selected())}><Dropdown.Trigger iconOnly variant="ghost" label={t().actions} disabled={busy()}><i class="ti ti-dots"/></Dropdown.Trigger></Dropdown.Root>
              </div>
            </div>
            <Show when={error()}><Placeholder state="error" title={t().REQUEST_FAILED} description={error()} /></Show>
            <Show when={props.view==="edit"}><ManualEditor bundle={selected()} userId={props.userId} selectedFile={props.selectedFile} onSaved={setApp} onDirtyChange={setEditorDirty} onPublish={()=>void publish(selected())} publishing={busy()}/></Show>
            <Show when={props.view==="database"&&props.databaseStatus} keyed>{status=><SqlConsole id={selected().id} userId={props.userId} initialStatus={status}/>}</Show>
            <Show when={!props.view||props.view==="app"}><Show when={selectedVersion() ?? "current"} keyed>{version =>
              <ArtifactPanel artifactId={selected().id} userId={props.userId} version={typeof version === "number" ? version : undefined}
                published={typeof version !== "number" && !!selected().publishedRevision} autoStart
                browseVersions={selected().permission === "admin" ? () => void versions(selected()) : undefined} />
            }</Show></Show>
          </>}
        </Show>
      </div>
    </AppWorkspace.Main></AppWorkspace.Content>
  </AppWorkspace></AssistantLiveProvider>;
}
