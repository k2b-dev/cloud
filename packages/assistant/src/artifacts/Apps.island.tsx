import { AppWorkspace, Button, Dropdown, NoticeCard, Paper, Placeholder, StatusBadge, Tabs, prompts, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import { navigateTo } from "@k2b/ssr/nav";
import { createResource, createSignal, For, Show } from "solid-js";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import type { ArtifactBundle, ArtifactSummary, artifacts } from "./service";
import AssistantSidebar from "../frontend/AssistantSidebar";
import { AssistantLiveProvider, createAssistantLiveInvalidationHub } from "../frontend/assistant-live";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { ArtifactPanel } from "./ArtifactPanel";
import { assistantApi } from "../api/client";
import { openAssistantCreateProjectDialog } from "../frontend/AssistantProjectsDialog";
import { advancedMessages } from "./advanced-messages";
import { ManualEditor } from "./ManualEditor";
import { SqlConsole } from "./SqlConsole";
import { openDataDialog, openDatabaseDialog } from "./DataDialogs";

type Props = { kind?: "app" | "script"; userId: string; conversations: AiConversation[]; projects: AiProject[];
  initialList: Awaited<ReturnType<typeof artifacts.list>>; initialApp?: ArtifactBundle;
  view?:"app"|"edit"|"database"; selectedFile?:string;
  databaseStatus?:Awaited<ReturnType<typeof artifactClient.databaseStatus>> };

const studioPalette = [
  ["#4266a8", "#6ab5cd", "#9bbbf6"],
  ["#217f77", "#78b9a9", "#84d5c8"],
  ["#7660ab", "#bb9ad0", "#bfadf1"],
  ["#b37027", "#e5b979", "#efc189"],
  ["#ac586d", "#d39cad", "#efa9bc"],
  ["#397f98", "#8fc4d3", "#94d4ec"],
] as const;

function studioColor(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const [accent, secondary, dark] = studioPalette[(hash >>> 0) % studioPalette.length]!;
  return { "--studio-accent-light": accent, "--studio-secondary": secondary, "--studio-accent-dark": dark };
}

export default function Apps(props: Props) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const a=()=>advancedMessages.resolve([locale()]).t;
  const live = createAssistantLiveInvalidationHub({ onApplied: () => {} });
  const [selectedVersion, setSelectedVersion] = createSignal<number>();
  const page = () => props.initialList.page;
  const [list, setList] = createSignal(props.initialList);
  const reloadList = async () => setList(await artifactClient.list(page(), props.kind ?? "app"));
  const setPage = (next: (page: number) => number) => navigateTo(`/app/assistant/apps?kind=${props.kind ?? "app"}&page=${next(page())}`);
  const [app, setApp] = createSignal(props.initialApp);
  const [editorDirty,setEditorDirty]=createSignal(false);
  const [sharing, setSharing] = createSignal<ArtifactSummary>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [access] = createResource(() => sharing()?.id, artifactClient.access);
  async function action(run: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true); setError("");
    try { await run(); await reloadList(); }
    catch (e) { setError(e instanceof Error ? e.message : t().REQUEST_FAILED); }
    finally { setBusy(false); }
  }
  const open = (id: string) => navigateTo(`/app/assistant/apps/${id}`);
  const edit = (id: string) => action(async () => navigateTo((await artifactClient.editChat(id)).href));
  const share = async (item: ArtifactSummary) => {
    setSharing(item);
    await prompts.dialog<void>(() => <div class="assistant-version-list">
      <NoticeCard tone="info" title={t().sharedCodeTitle} detail={t().sharedCodeHelp} />
      <Show when={!item.publishedRevision}><NoticeCard tone="warning" title={t().unpublishedAccess} detail={t().unpublishedAccessHelp} /></Show>
      <Show when={!access.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
      <Show when={!access.error && access()} keyed fallback={<Placeholder state="error" title={t().loadFailed} />}>
        {entries => <PermissionEditor initialEntries={entries} canEdit allowPublic={false} allowServiceAccounts={false}
          allowedLevels={[{ level: "read", label: t().use }, { level: "admin", label: t().manage }]}
          grantAccess={async (principal, level) => {
            if (principal.type === "public" || principal.type === "service_account" || level === "write") throw new Error(t().INVALID_INPUT);
            const grant = await artifactClient.grant(item.id, principal, level);
            if (!grant) throw new Error(t().REQUEST_FAILED); return grant;
          }}
          updateAccess={async (accessId, level) => {
            if (level === "write") throw new Error(t().INVALID_INPUT);
            await artifactClient.changeGrant(item.id, accessId, level);
          }}
          revokeAccess={async accessId => { await artifactClient.changeGrant(item.id, accessId, null); }} />}
      </Show>
    </Show></div>, { title: `${t().share} · ${item.title}`, size: "medium" });
    setSharing(undefined);
    await reloadList();
  };
  const publish = async (item: ArtifactSummary) => {
    if(app()?.id===item.id&&editorDirty()){await prompts.alert(a().saveBeforePublish,{title:t().publish});return;}
    await action(async () => {
      const firstRelease = !item.publishedVersion && !(await artifactClient.versions(item.id)).items.length;
      const values = firstRelease ? { note: "Initial release" } : await prompts.form({ title: t().publish, confirmText: t().publish, fields: {
        note: { type:"text", label:t().changeNote, required:true, maxLength:1000, multiline:true },
      } });
      if (!values) return;
      await artifactClient.publish(item.id,item.revision,values.note);
      if (app()) { setApp(await artifactClient.get(item.id)); setSelectedVersion(undefined); }
    });
  };

  const versions = (item: ArtifactSummary) => prompts.dialog<void>((close) => {
    const [page,setPage] = createSignal(1);
    const [entries] = createResource(page,p => artifactClient.versions(item.id,p));
    return <div class="assistant-version-list">
      <NoticeCard tone="info" title={t().versions} detail={t().versionsHelp} />
      <Show when={!entries.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
        <Show when={!entries.error} fallback={<Placeholder state="error" title={t().loadFailed} />}>
          <Show when={entries()?.items.length} fallback={<Placeholder title={t().noVersions}
            action={<Button onClick={() => { close(); void publish(item); }}>{t().publish}</Button>} />}>
            <div class="assistant-version-rows"><For each={entries()?.items}>{entry => <div class="assistant-version-entry">
              <strong>v{entry.version}</strong><p>{entry.note}</p>
              <div class="assistant-version-entry__actions">
                <Button size="sm" variant="secondary" onClick={() => { setSelectedVersion(entry.version);close(); }}>{t().start}</Button>
                <Button size="sm" variant="ghost" onClick={() => { close(); void action(async () => {
                  const draft=await artifactClient.get(item.id);
                  const restored=await artifactClient.restore(item.id,entry.version,draft.revision);
                  setApp(restored); setSelectedVersion(restored.publishedVersion ?? undefined);
                }); }}>{t().restore}</Button>
              </div>
            </div>}</For></div>
          </Show>
          <Show when={page()>1 || entries()?.hasNext}><div class="assistant-studio-card__footer">
            <Button disabled={page()===1} onClick={()=>setPage(p=>p-1)}>{t().back}</Button>
            <Button disabled={!entries()?.hasNext} onClick={()=>setPage(p=>p+1)}>{t().next}</Button>
          </div></Show>
        </Show>
      </Show>
    </div>;
  },{title:t().versions,size:"medium"});
  const projectLinks=(item:ArtifactSummary)=>action(async()=>{
    const existing=await artifactClient.projects(item.id);
    await prompts.dialog<void>(()=>{
      const [linked,setLinked]=createSignal(new Set(existing.map(link=>link.projectId)));
      const [saving,setSaving]=createSignal(false),[failure,setFailure]=createSignal("");
      const available=props.projects.filter(project=>project.permission === "admin");
      return <div class="flex flex-col gap-3">
        <NoticeCard tone="info" title={t().projects} detail={t().projectScriptsHelp}/>
        <Show when={failure()}><NoticeCard tone="danger" title={failure()}/></Show>
        <For each={available}>{project=><div class="flex items-center justify-between gap-3"><span>{project.name}</span><Button size="sm" disabled={saving()} onClick={async()=>{
          setSaving(true);setFailure("");
          try {const next=!linked().has(project.id);await artifactClient.linkProject(item.id,project.id,next);setLinked(previous=>{const values=new Set(previous);if(next)values.add(project.id);else values.delete(project.id);return values;});}
          catch(error){setFailure(error instanceof Error ? error.message : t().REQUEST_FAILED);}finally{setSaving(false);}
        }}>{linked().has(project.id)?t().remove:t().add}</Button></div>}</For>
      </div>;
    },{title:t().projects,size:"medium"});
  });
  const menu = (item: ArtifactSummary) => [
    ...(app() && props.view && props.view!=="app" ? [{label:a().app,icon:"ti ti-app-window",action:()=>open(item.id)}] : []),
    ...(item.permission === "admin" ? [
      {label:t().remove,icon:"ti ti-trash",action:async()=>{
        if(await prompts.confirm(t().removeConfirm,{title:t().remove,variant:"danger"})) await action(async()=>{
          await artifactClient.remove(item.id);
          if(app()?.id===item.id)navigateTo(`/app/assistant/apps?kind=${item.kind}`);
        });
      }},
      { label: a().assistantEdit, icon: "ti ti-edit", action: () => edit(item.id) },
      { label: t().share, icon: "ti ti-users", action: () => share(item) },
      ...(item.kind === "script" ? [{label:t().projects,icon:"ti ti-folders",action:()=>projectLinks(item)}] : []),
      { label: item.publishedRevision ? t().publishUpdate : t().publish, icon: "ti ti-upload",
        disabled: item.publishedRevision === item.revision,
        action: () => publish(item) },
      ...(item.publishedRevision ? [{ label: t().unpublish, icon: "ti ti-eye-off", action: () => action(() => artifactClient.unpublish(item.id)) }] : []),
    ] : []),
    ...(item.publishedRevision ? [{ label: t().fork, icon: "ti ti-copy", action: () => action(async () => {
      const copy = await artifactClient.fork(item.id);
      navigateTo((await artifactClient.editChat(copy.id)).href);
    }) }] : []),
    {sectionLabel:a().advanced,items:[
      ...(item.permission==="admin"?[
        {label:a().manualEdit,icon:"ti ti-code",action:()=>navigateTo(`/app/assistant/apps/${item.id}/edit`)},
        {label:a().sql,icon:"ti ti-database",action:()=>navigateTo(`/app/assistant/apps/${item.id}/database`)},
      ]:[]),
      {label:a().local,icon:"ti ti-device-desktop",action:()=>openDataDialog(item.id,props.userId,"local",a().local)},
      ...(item.permission==="admin"?[
        {label:a().shared,icon:"ti ti-cloud",action:()=>openDataDialog(item.id,props.userId,"shared",a().shared)},
        {label:a().database,icon:"ti ti-database-cog",action:()=>openDatabaseDialog(item.id,a().database)},
      ]:[]),
    ]},
  ];
  return <AssistantLiveProvider value={live}><AppWorkspace class="flex-1 min-h-0">
    <AssistantSidebar conversations={() => props.conversations} projects={props.projects} activeView="apps" live={live}
      creatingConversation={busy}
      onNewConversation={() => action(async () => navigateTo(`/app/assistant?conversation=${(await assistantApi.createConversation()).shortId}`))}
      onCreateProject={async () => { const project = await openAssistantCreateProjectDialog(); if (project) navigateTo(`/app/assistant?project=${project.id}`); }} />
    <AppWorkspace.Content><AppWorkspace.Main scroll={!app()}>
      <div class="assistant-apps-page" classList={{ "assistant-apps-page--runner": !!app() }}>
        <Show when={app()} fallback={<>
          <h1 class="text-xl font-semibold">{t().apps}</h1>
          <Tabs value={() => props.kind ?? "app"} onValueChange={kind => navigateTo(`/app/assistant/apps?kind=${kind}`)} ariaLabel={t().apps}
            options={[{value:"app",label:t().guiApps},{value:"script",label:t().scripts}]} />
          <Show when={error()}><Placeholder state="error" title={t().REQUEST_FAILED} description={error()} /></Show>
              <Show when={list()?.items.length} fallback={<Placeholder title={t().noAccessibleApps} />}>
                <div class="assistant-apps-grid"><For each={list()?.items}>{item =>
                  <Paper class="assistant-studio-card" style={studioColor(item.id)}>
                    <div class="assistant-studio-card__top" classList={{ "assistant-studio-card__top--title-only": !item.description?.trim() }}>
                      <div class="assistant-studio-card__icon" aria-hidden="true"><i class={item.icon ?? "ti ti-app-window"} /></div>
                      <div class="assistant-studio-card__copy">
                        <h2 class="assistant-studio-card__title">{item.title}</h2>
                        <Show when={item.description?.trim()}><p class="assistant-studio-card__description">{item.description}</p></Show>
                      </div>
                      <div class="assistant-studio-card__menu"><Dropdown.Root items={menu(item)}>
                        <Dropdown.Trigger iconOnly variant="ghost" label={`${t().actions} · ${item.title}`} disabled={busy()}><i class="ti ti-dots" /></Dropdown.Trigger>
                      </Dropdown.Root></div>
                    </div>
                    <div class="assistant-studio-card__footer">
                      <Show when={item.publishedRevision}><StatusBadge variant="dot" tone="running" label={t().published} /></Show>
                      <Button size="sm" variant="secondary" class="assistant-studio-card__start" onClick={() => open(item.id)}><i class="ti ti-player-play" />{t().start}</Button>
                    </div>
                  </Paper>
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
