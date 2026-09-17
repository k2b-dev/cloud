import { openSecretsDialog } from "./SecretsDialog";
import { Button, NoticeCard, Placeholder, prompts, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import { navigateTo } from "@k2b/ssr/nav";
import { createResource, createSignal, For, Show, type Accessor } from "solid-js";
import type { AiProject } from "@k2b/cloud/ai";
import type { ArtifactBundle, ArtifactSummary } from "./service";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { advancedMessages } from "./advanced-messages";
import { openDataDialog, openDatabaseDialog } from "./DataDialogs";
export function createArtifactActions(props: { userId: string; projects: AiProject[]; refresh?: () => Promise<unknown>; app?: Accessor<ArtifactBundle | undefined>; editorDirty?: Accessor<boolean>; setApp?: (app: ArtifactBundle) => void; setSelectedVersion?: (version: number | undefined) => void; view?: "app" | "edit" | "database" }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t, a = () => advancedMessages.resolve([locale()]).t;
  const [sharing, setSharing] = createSignal<ArtifactSummary>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [access] = createResource(() => sharing()?.id, artifactClient.access);
  async function action(run: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true); setError("");
    try { await run(); await props.refresh?.(); }
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
    await props.refresh?.();
  };
  const publish = async (item: ArtifactSummary) => {
    if(props.app?.()?.id===item.id&&props.editorDirty?.()){await prompts.alert(a().saveBeforePublish,{title:t().publish});return;}
    await action(async () => {
      const firstRelease = !item.publishedVersion && !(await artifactClient.versions(item.id)).items.length;
      const values = firstRelease ? { note: "Initial release" } : await prompts.form({ title: t().publish, confirmText: t().publish, fields: {
        note: { type:"text", label:t().changeNote, required:true, maxLength:1000, multiline:true },
      } });
      if (!values) return;
      await artifactClient.publish(item.id,item.revision,values.note);
      if (props.app?.()) { props.setApp?.(await artifactClient.get(item.id)); props.setSelectedVersion?.(undefined); }
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
                <Button size="sm" variant="secondary" onClick={() => { props.setSelectedVersion?.(entry.version);close(); }}>{t().start}</Button>
                <Button size="sm" variant="ghost" onClick={() => { close(); void action(async () => {
                  const draft=await artifactClient.get(item.id);
                  const restored=await artifactClient.restore(item.id,entry.version,draft.revision);
                  props.setApp?.(restored); props.setSelectedVersion?.(restored.publishedVersion ?? undefined);
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
    ...(props.app?.() && props.view && props.view!=="app" ? [{label:a().app,icon:"ti ti-app-window",action:()=>open(item.id)}] : []),
    ...(item.permission === "admin" ? [
      {label:t().remove,icon:"ti ti-trash",action:async()=>{
        if(await prompts.confirm(t().removeConfirm,{title:t().remove,variant:"danger"})) await action(async()=>{
          await artifactClient.remove(item.id);
          if(props.app?.()?.id===item.id)navigateTo("/app/assistant?studio=1");
        });
      }},
      { label: a().assistantEdit, icon: "ti ti-edit", action: () => edit(item.id) },
      { label: t().share, icon: "ti ti-users", action: () => share(item) },
      {label:t().projects,icon:"ti ti-folders",action:()=>projectLinks(item)},
      { label: item.publishedRevision ? t().publishUpdate : t().publish, icon: "ti ti-upload",
        disabled: item.publishedRevision === item.revision,
        action: () => publish(item) },
      ...(item.publishedRevision ? [{ label: t().unpublish, icon: "ti ti-eye-off", action: () => action(async () => {
        await artifactClient.unpublish(item.id);
        if (props.app?.()?.id === item.id) { props.setApp?.(await artifactClient.get(item.id)); props.setSelectedVersion?.(undefined); }
      }) }] : []),
    ] : []),
    ...(item.publishedRevision ? [{ label: t().fork, icon: "ti ti-copy", action: () => action(async () => {
      const copy = await artifactClient.fork(item.id);
      navigateTo((await artifactClient.editChat(copy.id)).href);
    }) }] : []),
    {sectionLabel:a().advanced,items:[
      {label:"Secrets",icon:"ti ti-key",action:()=>openSecretsDialog({resourceId:item.id})},
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
  return { menu, action, busy, error, publish, versions };
}
