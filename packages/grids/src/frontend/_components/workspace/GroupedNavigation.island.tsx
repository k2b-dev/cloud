import { AppWorkspace, IconButtonLink, prompts, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { type NavigationGroup, NavigationResourceTypeSchema, navigationReferenceKey } from "../../../navigation-contracts";
import { navigationMessages } from "../../../navigation-messages";
import { NAVIGATION_EXPANSION_EVENT, parseNavigationExpansion, setNavigationExpansion } from "../sidebar/GridsSettingsStore";
import { sidebarMessages } from "../sidebar/messages";
import { openSidebarForm } from "../sidebar/open-sidebar-form";
import { workspaceMessages } from "./messages";
import type { NavigationResource } from "./navigation-catalog";
import { initialNavigationExpansion } from "./navigation-expansion";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

export default function GroupedNavigation(props: {
  baseId: string;
  groups: NavigationGroup[];
  resources: NavigationResource[];
  active: string | null;
  initialExpanded?: string[];
  forms: PublicOkWorkspaceState["catalog"]["sidebarForms"];
  fields: PublicOkWorkspaceState["catalog"]["fieldsByTable"];
  editMode: boolean;
  dateConfig: PublicOkWorkspaceState["dateConfig"];
}) {
  const locale = useLocale();
  const { t } = navigationMessages.resolve([locale()]);
  const { t: formText } = sidebarMessages.resolve([locale()]);
  const { t: workspaceText } = workspaceMessages.resolve([locale()]);
  const typeLabels = {
    table: workspaceText.tables,
    view: workspaceText.views,
    form: workspaceText.forms,
    documentTemplate: workspaceText.documents,
    workflow: workspaceText.workflows,
    customApp: workspaceText.apps,
  };
  const types = NavigationResourceTypeSchema.options.filter(
    (type) => type === "documentTemplate" || (props.groups.length > 0 && props.resources.some((item) => item.type === type)),
  );
  const [expanded, setExpanded] = createSignal(initialNavigationExpansion(props.groups, props.initialExpanded, props.active, types));
  onMount(() => {
    const sync = () => {
      const stored = parseNavigationExpansion(document.cookie, props.baseId);
      if (stored) setExpanded(initialNavigationExpansion(props.groups, stored, null, types));
    };
    window.addEventListener(NAVIGATION_EXPANSION_EVENT, sync);
    onCleanup(() => window.removeEventListener(NAVIGATION_EXPANSION_EVENT, sync));
  });
  const byKey = new Map(props.resources.map((item) => [navigationReferenceKey(item), item]));
  const activeGroup = props.groups.find((group) => group.entries.some((entry) => navigationReferenceKey(entry) === props.active));
  const selected = props.active
    ? `${activeGroup ? `group:${activeGroup.id}` : `type:${props.active.split(":")[0]}`}/${props.active}`
    : null;
  const item = (resource: NavigationResource, parent: string) => (
    <AppWorkspace.NavTree.Item
      id={`${parent}/${navigationReferenceKey(resource)}`}
      label={resource.name}
      icon={resource.icon}
      href={resource.href}
      navigation="document"
      title={resource.context ? `${resource.name} · ${resource.context}` : resource.name}
      meta={
        resource.status ? <span class="text-[9px] uppercase tracking-wider text-dimmed">{workspaceText[resource.status]}</span> : undefined
      }
      actions={
        resource.type === "customApp" && props.active === navigationReferenceKey(resource) ? (
          <AppWorkspace.SidebarItemActions>
            <IconButtonLink
              label={workspaceText.settingsFor({ name: resource.name })}
              href={`/app/grids/${props.baseId}/apps/${resource.id}?edit=true&settings=app`}
              navigation="document"
              variant="ghost"
              size="xs"
            >
              <i class="ti ti-settings" aria-hidden="true" />
            </IconButtonLink>
          </AppWorkspace.SidebarItemActions>
        ) : undefined
      }
      onSelect={
        resource.type === "form"
          ? () => {
              const form = props.forms.find((entry) => entry.form.id === resource.id)?.form;
              if (form)
                void openSidebarForm(
                  { form, fields: props.fields[form.tableId] ?? [], editMode: props.editMode, dateConfig: props.dateConfig },
                  formText,
                ).catch((error) => prompts.error(error instanceof Error ? error.message : formText.openFormEditorFailed));
            }
          : undefined
      }
    />
  );
  return (
    <>
      {props.groups.length > 0 && (
        <AppWorkspace.NavTree
          ariaLabel={t.overview}
          selectedId={selected}
          expandedIds={expanded()}
          onExpandedIdsChange={(ids) => {
            setExpanded([...ids]);
            setNavigationExpansion(props.baseId, [...ids]);
          }}
        >
          {props.groups.map((group) => (
            <AppWorkspace.NavTree.Item id={`group:${group.id}`} label={group.name} icon="ti ti-folder" expandedIcon="ti ti-folder-open">
              {group.entries.flatMap((entry) => {
                const resource = byKey.get(navigationReferenceKey(entry));
                return resource ? [item(resource, `group:${group.id}`)] : [];
              })}
            </AppWorkspace.NavTree.Item>
          ))}
        </AppWorkspace.NavTree>
      )}
      <AppWorkspace.SidebarSection title={props.groups.length > 0 ? t.allResources : undefined}>
        <AppWorkspace.NavTree
          ariaLabel={t.allResources}
          selectedId={selected}
          expandedIds={expanded()}
          onExpandedIdsChange={(ids) => {
            setExpanded([...ids]);
            setNavigationExpansion(props.baseId, [...ids]);
          }}
        >
          {types.map((type) => (
            <AppWorkspace.NavTree.Item id={`type:${type}`} label={typeLabels[type]} icon="ti ti-list">
              {type === "documentTemplate" && (
                <AppWorkspace.NavTree.Item
                  id="type:documentTemplate/documentTemplate:all"
                  label={workspaceText.allDocuments}
                  icon="ti ti-files"
                  href={`/app/grids/${props.baseId}/documents${props.editMode ? "?edit=true" : ""}`}
                  navigation="document"
                />
              )}
              {props.resources.filter((resource) => resource.type === type).map((resource) => item(resource, `type:${type}`))}
            </AppWorkspace.NavTree.Item>
          ))}
        </AppWorkspace.NavTree>
      </AppWorkspace.SidebarSection>
    </>
  );
}
