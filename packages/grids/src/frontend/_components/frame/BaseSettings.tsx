import { principalLabel } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, Field, Input, List, Menu, Pane, Row, Section, Tabs, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { createScopedAccess } from "../permissions/ScopedAccessSection";
import { createBaseSettings } from "../sidebar/base-settings";
import { errorMessage } from "../utils/api-helpers";
import { navigationResources, navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import GridsFrame, { type GridsBases, LiveNotice } from "./GridsFrame";
import { frameMessages } from "./messages";

/** The tabs of a base's settings page that are built on v2; the rest still opens in the earlier dialog. */
export const SETTINGS_TABS = ["general", "access"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const settingsHref = (baseId: string, tab: SettingsTab) => `/app/grids/${baseId}/settings${tab === "general" ? "" : `/${tab}`}`;

export type BaseSettingsProps = {
  state: PublicOkWorkspaceState;
  tab: SettingsTab;
  /** Who has access, read on the server for the access tab. */
  access?: AccessEntry[];
  bases?: GridsBases;
};

/**
 * A base's settings as a page of its own under the base (as Pulse and Venue have them), its tab in the address:
 * General and Access on v2; the parts not built on v2 yet open in the earlier dialog at their tab, from the head's
 * "More settings", so no setting is out of reach.
 */
export default function BaseSettings(props: BaseSettingsProps) {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const legacy = createBaseSettings({
    base: props.state.base,
    navigationResources: navigationResources(props.state.base.id, props.state.catalog),
  });
  const more = () =>
    (
      [
        [t().settingsNavigation, "list-tree", "navigation"],
        [t().settingsTables, "table-options", "tables"],
        [t().settingsDocuments, "file-type-pdf", "documents"],
        [t().settingsEmailTemplates, "mail", "emailTemplates"],
        [t().settingsTrash, "trash", "trash"],
        [t().settingsLifecycle, "archive", "retention"],
      ] as const
    ).map(([label, icon, tab]) => ({ label, icon, onClick: () => void legacy.showSettings(tab) }));
  const tabs = () =>
    SETTINGS_TABS.map((tab) => ({
      label: tab === "general" ? t().tabGeneral : t().tabAccess,
      href: settingsHref(props.state.base.id, tab),
      current: props.tab === tab,
    }));
  // General: the name and description, saved from the head (on the phone the floating main action)
  const toast = useToast();
  const [name, setName] = createSignal(props.state.base.name);
  const [description, setDescription] = createSignal(props.state.base.description ?? "");
  const [saving, setSaving] = createSignal(false);
  const [tried, setTried] = createSignal(false);
  const changed = () => name() !== props.state.base.name || description() !== (props.state.base.description ?? "");
  const save = async () => {
    setTried(true);
    if (!name().trim() || saving()) return;
    setSaving(true);
    try {
      const response = await apiClient.bases[":baseId"].$patch({
        param: { baseId: props.state.base.id },
        json: { name: name().trim(), description: description().trim() || null },
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().saveFailed));
      toast(t().baseSaved, { status: "ok" });
      // the head, the switcher and the sidebar show the new name: the page reads its state again
      refreshCurrentPath();
    } catch (error) {
      toast(error instanceof Error ? error.message : t().saveFailed, { status: "bad" });
    } finally {
      setSaving(false);
    }
  };
  const saveAction = () =>
    props.tab === "general" ? { label: t().save, icon: "check", disabled: !changed() || saving(), onClick: () => void save() } : undefined;
  return (
    <GridsFrame
      state={navigationState(props.state)}
      activeKeys={[`base:${props.state.base.id}`]}
      revision={props.state.workspaceRevision}
      bases={props.bases}
      page="settings"
      primary={saveAction()}
      head={
        <Bar
          start={<Tabs label={t().settingsTabs} items={tabs()} />}
          end={
            <>
              <Show when={saveAction()}>
                {(action) => (
                  <Button variant="primary" icon={action().icon} disabled={action().disabled} onClick={action().onClick}>
                    {action().label}
                  </Button>
                )}
              </Show>
              {/* the parts not on v2 yet, in the earlier dialog at their tab; a "…" stays on the phone */}
              <Menu label={t().moreSettings} items={more()} />
            </>
          }
        />
      }
    >
      <Pane label={t().settingsTabs} scrollKey={`grids-settings-${props.state.base.id}`}>
        <LiveNotice />
        <Show when={props.tab === "general"}>
          <Section title={t().nameAndDescription} summary={t().nameAndDescriptionSummary}>
            <Field label={t().baseName} required error={tried() && !name().trim() ? t().nameRequired : undefined}>
              <Input value={name()} onInput={setName} />
            </Field>
            <Field label={t().baseDescription} optional={t().optional}>
              <Input multiline rows={3} value={description()} onInput={setDescription} />
            </Field>
          </Section>
        </Show>
        <Show when={props.tab === "access"}>
          <Access state={props.state} initial={props.access} />
        </Show>
      </Pane>
    </GridsFrame>
  );
}

/** Who may view, edit or manage the base; "Edit access" opens the shared access dialog. */
function Access(props: { state: PublicOkWorkspaceState; initial?: AccessEntry[] }) {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const access = createScopedAccess({
    scope: { type: "base", id: props.state.base.id },
    resourceName: props.state.base.name,
    initialEntries: props.initial,
  });
  const level = (permission: string) => ({ read: t().levelRead, write: t().levelWrite, admin: t().levelAdmin })[permission] ?? permission;
  return (
    <Section
      title={t().peopleAndGroups}
      count={access.entries()?.length}
      summary={t().peopleAndGroupsSummary}
      actions={
        access.manageable() ? [{ label: t().editAccess, icon: "lock-access", disabled: !access.entries(), onClick: access.run }] : undefined
      }
    >
      <Show when={access.refreshError()}>
        <Failed text={t().accessRefreshFailed} onRetry={() => void access.reload()} />
      </Show>
      <Show when={access.entries()}>
        {(entries) => (
          <List label={t().peopleAndGroups}>
            <For each={entries().filter((entry) => entry.permission !== "none")}>
              {(entry) => (
                <Row
                  // a person shows a face, a group the group's symbol
                  {...(entry.principal.type === "group"
                    ? { mark: { icon: "users-group" } }
                    : { avatar: { name: principalLabel(entry, locale()) } })}
                  lines={[principalLabel(entry, locale()), level(entry.permission)]}
                />
              )}
            </For>
          </List>
        )}
      </Show>
    </Section>
  );
}
