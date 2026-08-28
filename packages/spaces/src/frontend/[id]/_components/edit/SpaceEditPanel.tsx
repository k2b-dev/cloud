import { prompts, SettingsModal } from "@k2b/ui";
import { createSignal } from "solid-js";
import { useSpaceMessages } from "../../messages";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";
import { ApiKeysSection, PermissionsSection } from "./AccessSection";
import { CalendarSection } from "./CalendarSection";
import { DangerZone } from "./DangerZone";
import { DefaultsSection } from "./DefaultsSection";
import { GeneralSection } from "./GeneralSection";
import { StatusesSection } from "./StatusesSection";
import { TagsSection } from "./TagsSection";
import type { SpaceEditPanelProps } from "./types";
import { WormholesSection } from "./WormholesSection";

export default function SpaceEditPanel(props: SpaceEditPanelProps) {
  const m = useSpaceMessages();
  const isAdmin = () => props.isAdmin === true;
  const canWrite = () => props.canWrite === true;
  const [activeTab, setActiveTab] = createSignal(canWrite() ? "general" : "defaults");
  const [generalDirty, setGeneralDirty] = createSignal(false);
  const [tagsDirty, setTagsDirty] = createSignal(false);
  const [statusesDirty, setStatusesDirty] = createSignal(false);
  const [wormholesDirty, setWormholesDirty] = createSignal(false);
  const activeTabDirty = () => {
    if (activeTab() === "general") return generalDirty();
    if (activeTab() === "tags") return tagsDirty();
    if (activeTab() === "statuses") return statusesDirty();
    if (activeTab() === "wormholes") return wormholesDirty();
    return false;
  };
  const close = () => {
    if (props.onClose) props.onClose();
    else requestSpacesRouteNavigation(`/app/spaces/${props.space.id}`, { scroll: "preserve" });
  };
  const confirmDiscard = async () =>
    !activeTabDirty() ||
    prompts.confirm(m.discardChangesConfirm, {
      title: m.discardChanges,
      icon: "ti ti-alert-triangle",
      confirmText: m.discard,
      variant: "danger",
    });
  const requestTabChange = async (nextTab: string) => {
    if (nextTab === activeTab() || !(await confirmDiscard())) return;
    setActiveTab(nextTab);
  };
  const requestClose = async () => {
    if (await confirmDiscard()) close();
  };

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <SettingsModal
        title={m.spaceSettings}
        activeTab={activeTab()}
        onTabChange={(tab) => void requestTabChange(tab)}
        onClose={() => void requestClose()}
        closeLabel={m.closeSettings}
      >
        {canWrite() && (
          <SettingsModal.Group title={m.space}>
            <SettingsModal.Tab id="general" title={m.settingsGeneral} icon="ti ti-id" description={m.settingsGeneralDescription}>
              <GeneralSection space={props.space} onWorkspaceChange={props.onWorkspaceChange} onDirtyChange={setGeneralDirty} />
            </SettingsModal.Tab>
            <SettingsModal.Tab id="tags" title={m.tags} icon="ti ti-tags" description={m.settingsTagsDescription}>
              <TagsSection
                spaceId={props.space.id}
                tags={props.space.tags}
                onWorkspaceChange={props.onWorkspaceChange}
                onSettingsChange={props.onSettingsChange}
                onDirtyChange={setTagsDirty}
              />
            </SettingsModal.Tab>
            <SettingsModal.Tab id="statuses" title={m.statuses} icon="ti ti-columns-3" description={m.statusesDescription}>
              <StatusesSection
                spaceId={props.space.id}
                columns={props.space.columns}
                onWorkspaceChange={props.onWorkspaceChange}
                onSettingsChange={props.onSettingsChange}
                onDirtyChange={setStatusesDirty}
              />
            </SettingsModal.Tab>
          </SettingsModal.Group>
        )}

        <SettingsModal.Group title={m.personal}>
          <SettingsModal.Tab id="defaults" title={m.defaults} icon="ti ti-layout-sidebar" description={m.defaultsDescription}>
            <DefaultsSection spaceId={props.space.id} initialSettings={props.initialSettings} />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={m.connections}>
          <SettingsModal.Tab id="calendar" title={m.calendar} icon="ti ti-calendar-share" description={m.calendarTabDescription}>
            <CalendarSection spaceId={props.space.id} icalToken={props.space.icalToken} baseUrl={props.baseUrl} isAdmin={isAdmin()} />
          </SettingsModal.Tab>
          {isAdmin() && (
            <SettingsModal.Tab id="wormholes" title={m.wormholes} icon="ti ti-arrow-bounce" description={m.wormholesTabDescription}>
              <WormholesSection spaceId={props.space.id} initialWormholes={props.wormholes ?? []} onDirtyChange={setWormholesDirty} />
            </SettingsModal.Tab>
          )}
        </SettingsModal.Group>

        {isAdmin() && props.accessEntries && (
          <SettingsModal.Group title={m.sharing}>
            <SettingsModal.Tab id="access" title={m.access} icon="ti ti-shield" description={m.accessTabDescription}>
              <PermissionsSection
                spaceId={props.space.id}
                accessEntries={props.accessEntries}
                onWorkspaceChange={props.onWorkspaceChange}
              />
            </SettingsModal.Tab>
            <SettingsModal.Tab id="api-keys" title={m.apiKeys} icon="ti ti-key" description={m.apiKeysTabDescription}>
              <ApiKeysSection spaceId={props.space.id} apiKeys={props.apiKeys ?? []} />
            </SettingsModal.Tab>
          </SettingsModal.Group>
        )}

        {isAdmin() && (
          <SettingsModal.Group title={m.lifecycle}>
            <SettingsModal.Tab
              id="danger"
              title={m.dangerZone}
              icon="ti ti-alert-triangle"
              description={m.dangerZoneDescription}
              tone="danger"
            >
              <DangerZone spaceId={props.space.id} spaceName={props.space.name} />
            </SettingsModal.Tab>
          </SettingsModal.Group>
        )}
      </SettingsModal>
    </div>
  );
}
