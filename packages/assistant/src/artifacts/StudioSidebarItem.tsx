import { AppWorkspace, Button, IconButton, Placeholder, prompts, ScrollArea, useLocale } from "@k2b/ui";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantAppsSearchOptions } from "../frontend/assistant-search";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";

function StudioCatalog(props: { open: boolean; close: () => void; activeAppId?: string; modal?: boolean }) {
  const locale = useLocale();
  const t = () => artifactMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal(1);
  let pending: AbortController | undefined;
  const [apps, { refetch }] = createResource(() => props.open && page(), (value) => {
    pending?.abort();
    pending = new AbortController();
    return artifactClient.list(value, undefined, pending.signal);
  });
  createEffect(() => { if (!props.open) pending?.abort(); });
  onCleanup(() => pending?.abort());
  return <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <strong>{t().apps}</strong>
      <div class="flex items-center gap-1"><IconButton size="xs" label={t().search} onClick={() => { props.close(); openGlobalSearch(assistantAppsSearchOptions(locale())); }}>
        <i class="ti ti-search" aria-hidden="true" />
      </IconButton>
      <Show when={props.modal}><IconButton size="xs" label={t().closeDialog} onClick={props.close}><i class="ti ti-x" aria-hidden="true" /></IconButton></Show>
      </div>
    </div>
    <Show when={!apps.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
      <Show when={!apps.error} fallback={<Placeholder state="error" title={t().loadFailed} action={<Button onClick={() => void refetch()}>{t().retry}</Button>} />}>
        <For each={apps()?.items} fallback={<p class="px-2 py-1 text-xs text-dimmed">{t().emptyApps}</p>}>
          {(app) => <AppWorkspace.SidebarItem icon={app.icon || "ti ti-app-window"}
            href={`/app/assistant/apps/${app.id}`} onClick={props.close} active={app.id === props.activeAppId}>
            <AppWorkspace.SidebarItemLabel marquee={false}>{app.title}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>}
        </For>
      </Show>
    </Show>
    <Show when={page() > 1 || (!apps.error && apps()?.hasNext)}>
      <div class="flex justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={apps.loading || page() === 1} onClick={() => setPage(value => value - 1)}>{t().back}</Button>
        <Button size="sm" variant="ghost" disabled={apps.loading || !!apps.error || !apps()?.hasNext} onClick={() => setPage(value => value + 1)}>{t().next}</Button>
      </div>
    </Show>
  </div>;
}

export function openStudioDialog(options: { activeAppId?: string; signal?: AbortSignal } = {}) {
  return prompts.dialog<void>(close => <ScrollArea style={{ "max-height": "60dvh" }}>
    <StudioCatalog open close={close} activeAppId={options.activeAppId} modal />
  </ScrollArea>, { title: "Studio", header: false, size: "medium", signal: options.signal });
}

export function StudioSidebarItem(props: { active: boolean; activeAppId?: string }) {
  const locale = useLocale();
  const t = () => artifactMessages.resolve([locale()]).t;
  // Fetch only when opened; reopening refreshes publications and access.
  const [open, setOpen] = createSignal(false);
  return <AppWorkspace.SidebarItem icon="ti ti-app-window" title={t().apps} active={props.active}
    preview={{ label: t().apps, trigger: "row", onOpenChange: setOpen, content: close => <StudioCatalog open={open()} close={close} activeAppId={props.activeAppId} /> }}>
    {t().apps}
  </AppWorkspace.SidebarItem>;
}
