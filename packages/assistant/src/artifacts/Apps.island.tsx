import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { navigateTo } from "@k2b/ssr/nav";
import { AppWorkspace, Button, Dropdown, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { openAssistantCreateProjectDialog } from "../frontend/AssistantProjectsDialog";
import AssistantSidebar from "../frontend/AssistantSidebar";
import { AssistantLiveProvider, createAssistantLiveInvalidationHub } from "../frontend/assistant-live";
import { ArtifactPanel } from "./ArtifactPanel";
import { createArtifactActions } from "./artifact-actions";
import { artifactClient } from "./client";
import { ManualEditor } from "./ManualEditor";
import { artifactMessages } from "./messages";
import { SqlConsole } from "./SqlConsole";
import type { ArtifactBundle } from "./service";

type Props = {
  userId: string;
  doneCount: number;
  conversations: AiConversation[];
  projects: AiProject[];
  initialApp: ArtifactBundle;
  view?: "app" | "edit" | "database";
  selectedFile?: string;
  databaseStatus?: Awaited<ReturnType<typeof artifactClient.databaseStatus>>;
};

export default function Apps(props: Props) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const live = createAssistantLiveInvalidationHub({ onApplied: () => {} });
  const [sidebar, setSidebar] = createSignal({ conversations: props.conversations, projects: props.projects, doneCount: props.doneCount });
  const reloadSidebar = async () => setSidebar(await assistantApi.loadSidebar());
  const [selectedVersion, setSelectedVersion] = createSignal<number>();
  const [app, setApp] = createSignal(props.initialApp);
  const [editorDirty, setEditorDirty] = createSignal(false);
  const { menu, action, busy, error, publish, versions, openRunner } = createArtifactActions({
    userId: props.userId,
    app,
    setApp,
    editorDirty,
    setSelectedVersion,
    view: props.view,
  });
  return (
    <AssistantLiveProvider value={live}>
      <AppWorkspace mobileSurface="flush" class="flex-1 min-h-0">
        <AssistantSidebar
          conversations={() => sidebar().conversations}
          doneCount={sidebar().doneCount}
          projects={sidebar().projects}
          onConversationUpdated={() => void reloadSidebar()}
          onConversationArchived={() => void reloadSidebar()}
          activeView="apps"
          activeAppId={app()?.id}
          live={live}
          creatingConversation={busy}
          onNewConversation={() =>
            action(async () => navigateTo(`/app/assistant?conversation=${(await assistantApi.createConversation()).shortId}`))
          }
          onCreateProject={async () => {
            const project = await openAssistantCreateProjectDialog();
            if (project) navigateTo(`/app/assistant?project=${project.id}`);
          }}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <div class="assistant-apps-page assistant-apps-page--runner">
              <Show when={app()}>
                {(selected) => (
                  <>
                    <div class="assistant-studio-runner-header">
                      <h1>
                        <i class={selected().icon ?? "ti ti-app-window"} />
                        {selected().title}
                      </h1>
                      <div class="flex gap-2">
                        <Button variant="ghost" disabled={busy()} onClick={() => void openRunner(selected())}>
                          <i class="ti ti-maximize" aria-hidden="true" />
                          {t().openApp}
                        </Button>
                        <Dropdown.Root items={menu(selected())}>
                          <Dropdown.Trigger iconOnly variant="ghost" label={t().actions} disabled={busy()}>
                            <i class="ti ti-dots" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </div>
                    </div>
                    <Show when={error()}>
                      <Placeholder state="error" title={t().REQUEST_FAILED} description={error()} />
                    </Show>
                    <Show when={props.view === "edit"}>
                      <ManualEditor
                        bundle={selected()}
                        userId={props.userId}
                        selectedFile={props.selectedFile}
                        onSaved={setApp}
                        onDirtyChange={setEditorDirty}
                        onPublish={() => void publish(selected())}
                        publishing={busy()}
                      />
                    </Show>
                    <Show when={props.view === "database" && props.databaseStatus} keyed>
                      {(status) => <SqlConsole id={selected().id} userId={props.userId} initialStatus={status} />}
                    </Show>
                    <Show when={!props.view || props.view === "app"}>
                      <Show when={selectedVersion() ?? "current"} keyed>
                        {(version) => (
                          <ArtifactPanel
                            artifactId={selected().id}
                            userId={props.userId}
                            version={typeof version === "number" ? version : undefined}
                            published={typeof version !== "number" && !!selected().publishedRevision}
                            autoStart
                            onPublished={async () => {
                              setApp(await artifactClient.get(selected().id));
                            }}
                            browseVersions={selected().permission === "admin" ? () => void versions(selected()) : undefined}
                          />
                        )}
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </AssistantLiveProvider>
  );
}
