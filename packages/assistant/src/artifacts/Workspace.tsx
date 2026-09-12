import { AssistantChatContextContent, type ContextView } from "../frontend/AssistantChatContext";
import type { AiProject } from "@k2b/cloud/ai";
import { conversationFileSource } from "@k2b/cloud/ai/solid";
import { Button, Dropdown, NoticeCard, Placeholder, FileTree, FileView, prompts, Tabs, useLocale } from "@k2b/ui";
import { createEffect, createResource, createSignal, ErrorBoundary, For, onCleanup, Show, type JSX } from "solid-js";
import { ArtifactPanel } from "./ArtifactPanel";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { artifactSourceRenderers } from "./SourceRenderer";
import { appTab, closeWorkspaceTab, fileTab, openWorkspaceTab, sourceTab, workspaceSelectionFromHref, workspaceSelectionHref, type WorkspaceState, type WorkspaceTab } from "./workspace-state";

export function createArtifactWorkspace() {
  const [state, setState] = createSignal<WorkspaceState>({ tabs: [], active: null });
  const [mobile, setMobile] = createSignal("chat");
  const dirty = new Set<string>();
  const syncUrl = () => window.history.replaceState(window.history.state, "", workspaceSelectionHref(window.location.href, state().tabs.find((tab) => tab.key === state().active) ?? null));
  const open = (tab: WorkspaceTab) => { setState((state) => openWorkspaceTab(state, tab)); setMobile("workspace"); syncUrl(); };
  return {
    state, mobile, setMobile, open,
    rename: (key: string, title: string) => setState(state => ({ ...state, tabs: state.tabs.map(tab => tab.key === key ? { ...tab, title } : tab) })),
    restore: () => { const tab = workspaceSelectionFromHref(window.location.href); if (tab) open(tab); },
    select: (key: string) => { setState((state) => ({ ...state, active: key })); syncUrl(); },
    isDirty: (key: string) => dirty.has(key),
    setDirty: (key: string, value: boolean) => { value ? dirty.add(key) : dirty.delete(key); },
    close: (key: string) => { dirty.delete(key); setState((state) => closeWorkspaceTab(state, key)); if (!state().tabs.length) setMobile("chat"); syncUrl(); },
    hasDirty: () => dirty.size > 0,
  };
}
export type ArtifactWorkspaceController = ReturnType<typeof createArtifactWorkspace>;

function SourceFile(props: { tab: Extract<WorkspaceTab, { kind: "source" }>; dirty: (value: boolean) => void }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const [bundle, { mutate }] = createResource(() => artifactClient.get(props.tab.artifactId));
  const [conflict,setConflict]=createSignal(false);
  const [refresh,setRefresh]=createSignal(0);
  const [loading,setLoading]=createSignal(false);
  const [loadError,setLoadError]=createSignal("");
  return <><Show when={conflict()}><NoticeCard tone="warning" title={t().CONFLICT} detail={t().sourceConflict}/>
    <Show when={loadError()}><NoticeCard tone="danger" title={t().loadFailed} detail={loadError()}/></Show>
    <div class="flex gap-2">
      <Button loading={loading()} onClick={async()=>{
        if(!await prompts.confirm(t().unsavedMessage,{title:t().loadLatest,variant:"danger"}))return;
        setLoading(true);setLoadError("");
        try {mutate(await artifactClient.get(props.tab.artifactId));setRefresh(value=>value+1);setConflict(false);}
        catch(error){setLoadError(error instanceof Error ? error.message : t().REQUEST_FAILED);}
        finally{setLoading(false);}
      }}>{t().loadLatest}</Button>
    </div></Show><Show when={bundle()}>{(data) => <FileView
    file={{ path: props.tab.path }} revision={refresh()}
    renderers={artifactSourceRenderers}
    load={async () => {
      const file = data().source.files.find((file) => file.path === props.tab.path);
      if (!file) throw new Error(t().sourceMissing);
      return { encoding: "utf8", mediaType: "text/plain", content: file.content };
    }}
    save={data().permission !== "admin" ? undefined : async (content) => {
      const current = data();
      try { const updated = await artifactClient.update(current.id, {
        title: current.title, expectedRevision: current.revision,
        source: { ...current.source, files: current.source.files.map((file) => file.path === props.tab.path ? { ...file, content } : file) },
      });
      mutate(updated); setConflict(false);
      } catch(error) { if(error && typeof error==="object" && "code" in error && error.code==="CONFLICT")setConflict(true); throw error; }
    }}
    onDirtyChange={props.dirty}
  />}</Show></>;
}

function ChatFile(props: { tab: Extract<WorkspaceTab, { kind: "file" }>; refreshKey: string; dirty: (value: boolean) => void }) {
  const source = conversationFileSource("/api/ai", props.tab.conversationId);
  const [dirty, setDirty] = createSignal(false);
  const [revision, setRevision] = createSignal(props.refreshKey);
  createEffect(() => { if (!dirty()) setRevision(props.refreshKey); });
  return <FileView file={{ path: props.tab.path }} load={() => source.read(props.tab.path)} revision={revision()}
    save={source.write ? (content) => source.write!(props.tab.path, content, "utf8") : undefined}
    onDirtyChange={(value) => { setDirty(value); props.dirty(value); }}
    downloadHref={source.downloadHref?.(props.tab.path)} />;
}

function SourceDirectory(props: { artifactId: string; open: (path: string) => void }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const [bundle, { refetch }] = createResource(() => props.artifactId, id => artifactClient.get(id));
  return <Show when={bundle()} fallback={<Placeholder state={bundle.error ? "error" : "loading"} description={bundle.error?.message} action={bundle.error ? <Button onClick={() => void refetch()}>{t().refresh}</Button> : undefined} />}>
    {data => <FileTree label={t().source} entries={data().source.files.map(file => ({ path: file.path }))} onSelect={file => { if (file.kind !== "folder") props.open(file.path); }} />}
  </Show>;
}

export function ArtifactWorkspace(props: { controller: ArtifactWorkspaceController; userId: string; refreshKey: string; menuItems?: import("@k2b/ui").DropdownItem[]; project?: AiProject | null; conversationId?: string | null; onOpenView?: (view: ContextView) => void }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const state = props.controller.state;
  const title = (tab: WorkspaceTab) => tab.kind === "context" ? t()[tab.category] : tab.title;
  async function close(key = state().active) {
    if (!key) return;
    if (props.controller.isDirty(key) && !await prompts.confirm(t().unsavedMessage, { title: t().unsavedTitle, variant: "danger" })) return;
    props.controller.close(key);
  }
  return <div class="artifact-workspace">
    <div class="artifact-workspace__tabs">
      <Tabs variant="pill" trailing={<Show when={props.menuItems?.length}><Dropdown.Root items={props.menuItems ?? []}><Dropdown.Trigger iconOnly label={t().open}><i class="ti ti-plus" aria-hidden="true" /></Dropdown.Trigger></Dropdown.Root></Show>} value={() => state().active ?? ""} onValueChange={props.controller.select} ariaLabel={t().workspace}
        options={state().tabs.map((tab) => ({ value: tab.key, label: title(tab), icon: tab.kind === "app" ? "ti ti-app-window" : "ti ti-file-code", onClose: () => void close(tab.key), closeLabel: `${t().close}: ${title(tab)}` }))} />
      <Button class="artifact-mobile-toggle" size="sm" variant="ghost" onClick={() => props.controller.setMobile("chat")}>{t().chat}</Button>
    </div>
    <For each={state().tabs.map((tab) => tab.key)}>{(key) => {
      // Key by identity, not by snapshot object. Switching tabs never remounts a run or editor.
      const tab = state().tabs.find((tab) => tab.key === key)!;
      onCleanup(() => props.controller.setDirty(key, false));
      return <div class="artifact-workspace__tab" hidden={state().active !== key} aria-label={tab.title}>
        <ErrorBoundary fallback={(_error, reset) => <Placeholder
          state="error" variant="panel" title={t().loadFailed}
          description={t().loadFailedDescription}
          action={<Button variant="secondary" onClick={reset}><i class="ti ti-refresh" aria-hidden="true" />{t().retry}</Button>}
        />}>
        {tab.kind === "context" ? <AssistantChatContextContent chatId={tab.conversationId} project={tab.project !== undefined ? tab.project : tab.conversationId === props.conversationId ? props.project : undefined} category={tab.category} onOpenView={props.onOpenView} onOpenApp={(id, title) => props.controller.open(appTab(id, title))} /> : tab.kind === "view" ? tab.render() : tab.kind === "app" ? <ArtifactPanel refreshKey={props.refreshKey} artifactId={tab.artifactId} userId={props.userId} onTitle={title => props.controller.rename(key, title)} browseSource={() => props.controller.open({ kind: "view", key: `${tab.artifactId}:source`, title: t().source, render: () => <SourceDirectory artifactId={tab.artifactId} open={path => props.controller.open(sourceTab(tab.artifactId, path))} /> })} />
          : tab.kind === "file" ? <ChatFile tab={tab} refreshKey={props.refreshKey} dirty={(value) => props.controller.setDirty(key, value)} />
          : <SourceFile tab={tab} dirty={(value) => props.controller.setDirty(key, value)} />}
        </ErrorBoundary>
      </div>;
    }}</For>
  </div>;
}
