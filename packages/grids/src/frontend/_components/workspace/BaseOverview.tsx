import { AppWorkspace, Button, ButtonLink, Paper, Placeholder, prompts, Select, Tabs, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { NavigationResourceTypeSchema, navigationReferenceKey } from "../../../navigation-contracts";
import { navigationMessages } from "../../../navigation-messages";
import { sidebarMessages } from "../sidebar/messages";
import { openSidebarForm } from "../sidebar/open-sidebar-form";
import { workspaceMessages } from "./messages";
import { type NavigationResource, navigationResources } from "./navigation-catalog";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

export default function BaseOverview(props: { state: PublicOkWorkspaceState }) {
  const state = props.state;
  const locale = useLocale();
  const { t } = navigationMessages.resolve([locale()]);
  const { t: formText } = sidebarMessages.resolve([locale()]);
  const { t: workspaceText } = workspaceMessages.resolve([locale()]);
  const resources = navigationResources(state.base.id, state.catalog, state.adminModeRequested);
  const byKey = new Map(resources.map((resource) => [navigationReferenceKey(resource), resource]));
  const [search, setSearch] = createSignal("");
  const [type, setType] = createSignal<string | null>(null);
  const resolveTab = (href: string) => {
    const value = new URL(href, "http://grids.local").searchParams.get("tab");
    return value === "groups" || value === "resources" ? value : state.navigation?.groups.length ? "groups" : "resources";
  };
  const [tab, setTab] = createSignal(resolveTab(state.rememberPath));
  const selectTab = (value: string) => {
    if (value !== "groups" && value !== "resources") return;
    if (tab() === value) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.pushState(window.history.state, "", url);
    setTab(value);
  };
  onMount(() => {
    const restore = () => setTab(resolveTab(window.location.href));
    window.addEventListener("popstate", restore);
    onCleanup(() => window.removeEventListener("popstate", restore));
  });
  const typeLabels = {
    table: workspaceText.tables,
    view: workspaceText.views,
    form: workspaceText.forms,
    documentTemplate: t.documentTemplates,
    workflow: workspaceText.workflows,
    customApp: workspaceText.apps,
  };
  const filtered = createMemo(() =>
    resources.filter(
      (item) =>
        (!type() || item.type === type()) &&
        `${item.name} ${item.context ?? ""} ${t[item.type]}`
          .toLocaleLowerCase(locale())
          .includes(search().trim().toLocaleLowerCase(locale())),
    ),
  );
  const groups = createMemo(() =>
    NavigationResourceTypeSchema.options
      .map((type) => ({
        type,
        entries: filtered().filter((resource) => resource.type === type),
      }))
      .filter((group) => group.entries.length),
  );
  const openForm = (resource: NavigationResource) => {
    const form = state.catalog.sidebarForms.find((item) => item.form.id === resource.id)?.form;
    if (form)
      void openSidebarForm(
        { form, fields: state.catalog.fieldsByTable[form.tableId] ?? [], editMode: state.adminModeRequested, dateConfig: state.dateConfig },
        formText,
      ).catch((error) => prompts.error(error instanceof Error ? error.message : formText.openFormEditorFailed));
  };
  const resourceContent = (resource: NavigationResource) => (
    <span class="flex w-full min-w-0 items-center gap-3">
      <i class={resource.icon} aria-hidden="true" />
      <span class="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <span class="truncate font-medium">{resource.name}</span>
        <span class="truncate text-xs font-normal text-dimmed">
          {t[resource.type]}
          {resource.status ? ` (${workspaceText[resource.status]})` : ""}
          {resource.context ? ` · ${resource.context}` : ""}
        </span>
      </span>
    </span>
  );
  const resourceLink = (resource: NavigationResource) =>
    resource.href ? (
      <ButtonLink variant="ghost" href={resource.href} title={resource.name} class="grids-navigation-link w-full text-left">
        {resourceContent(resource)}
      </ButtonLink>
    ) : (
      <Button variant="ghost" onClick={() => openForm(resource)} title={resource.name} class="grids-navigation-link w-full text-left">
        {resourceContent(resource)}
      </Button>
    );
  return (
    <AppWorkspace.Main>
      <div class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
        <header>
          <h1 class="text-2xl font-semibold">{state.base.name}</h1>
          <Show when={state.base.description}>
            <p class="mt-2 text-dimmed">{state.base.description}</p>
          </Show>
        </header>
        <Tabs value={tab} onValueChange={selectTab} ariaLabel={t.overview}>
          <Tabs.Item value="groups" label={t.groups} icon="ti ti-folders">
            <Show when={state.navigation?.groups.length} fallback={<Placeholder title={t.noGroupsYet} />}>
              <div class="grids-navigation-columns">
                <For each={state.navigation?.groups}>
                  {(group) => (
                    <Paper class="p-4">
                      <h2 class="mb-3 font-semibold">{group.name}</h2>
                      <ul class="flex flex-col gap-1">
                        {group.entries.flatMap((entry) => {
                          const resource = byKey.get(navigationReferenceKey(entry));
                          return resource ? [<li>{resourceLink(resource)}</li>] : [];
                        })}
                      </ul>
                    </Paper>
                  )}
                </For>
              </div>
            </Show>
          </Tabs.Item>
          <Tabs.Item value="resources" label={t.allResources} icon="ti ti-list">
            <section class="flex flex-col gap-4">
              <div class="grid gap-3 sm:grid-cols-[1fr_14rem]">
                <TextInput label={t.search} value={search} onValueChange={setSearch} icon="ti ti-search" />
                <Select
                  label={t.allTypes}
                  placeholder={t.allTypes}
                  value={type}
                  onValueChange={setType}
                  clearable
                  options={NavigationResourceTypeSchema.options.map((type) => ({ value: type, label: typeLabels[type] }))}
                />
              </div>
              <Show when={groups().length} fallback={<Placeholder title={t.empty} />}>
                <div class="grids-navigation-columns">
                  <For each={groups()}>
                    {(group) => (
                      <Paper class="p-4">
                        <h3 class="mb-3 flex items-center justify-between gap-2 font-semibold">
                          <span>{typeLabels[group.type]}</span>
                          <span class="text-sm font-normal text-dimmed">{group.entries.length}</span>
                        </h3>
                        <ul class="flex flex-col gap-1">
                          <For each={group.entries}>{(resource) => <li>{resourceLink(resource)}</li>}</For>
                        </ul>
                      </Paper>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </Tabs.Item>
        </Tabs>
      </div>
    </AppWorkspace.Main>
  );
}
