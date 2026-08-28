import { prompts, SettingsModal, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { ApiKeysSection, PermissionsSection } from "./AccessSection";
import { DangerZone } from "./DangerZone";
import { ExportSection } from "./ExportSection";
import { FeaturesSection } from "./FeaturesSection";
import { GeneralSection } from "./GeneralSection";
import type { NotebookSettingsProps } from "./types";
import { notebookSettingsMessages } from "./messages";

export const openNotebookSettingsDialog = (props: NotebookSettingsProps): Promise<void> =>
  prompts.dialog<void>((close) => <NotebookSettingsBody {...props} close={() => close()} />, {
    surface: "bare",
    header: false,
    size: "large",
    cancelBehavior: "ignore",
  });

export function NotebookSettingsBody(props: NotebookSettingsProps & { close: () => void }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const [notebook, setNotebook] = createSignal(props.notebook);
  const [activeTab, setActiveTab] = createSignal("general");
  const [generalDirty, setGeneralDirty] = createSignal(false);
  const [exportDirty, setExportDirty] = createSignal(false);
  const activeTabDirty = () => (activeTab() === "general" ? generalDirty() : activeTab() === "export" ? exportDirty() : false);

  const confirmDiscard = async () =>
    !activeTabDirty() ||
    prompts.confirm(t().discardConfirm, {
      title: t().discardTitle,
      icon: "ti ti-alert-triangle",
      confirmText: t().discard,
      variant: "danger",
    });

  const requestTabChange = async (nextTab: string) => {
    if (nextTab === activeTab() || !(await confirmDiscard())) return;
    setActiveTab(nextTab);
  };

  const requestClose = async () => {
    if (await confirmDiscard()) props.close();
  };

  return (
    <div class="dialog-fixed-frame flex min-h-0 flex-col overflow-hidden">
      <SettingsModal
        title={t().settings}
        activeTab={activeTab()}
        onTabChange={(tab) => void requestTabChange(tab)}
        onClose={() => void requestClose()}
        closeLabel={t().closeSettings}
      >
        <SettingsModal.Group title={t().notebook}>
          <SettingsModal.Tab id="general" title={t().general} icon="ti ti-id" description={t().generalDescription}>
            <GeneralSection
              notebook={notebook()}
              tree={props.tree}
              canWrite={props.canWrite}
              dateConfig={props.dateConfig}
              onNotebookChange={setNotebook}
              onDirtyChange={setGeneralDirty}
            />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="features"
            title={t().viewBehavior}
            icon="ti ti-toggle-right"
            description={t().viewBehaviorDescription}
          >
            <FeaturesSection notebook={notebook()} isAdmin={props.isAdmin} onNotebookChange={setNotebook} />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        {props.isAdmin && (
          <>
            <SettingsModal.Group title={t().sharing}>
              <SettingsModal.Tab id="access" title={t().access} icon="ti ti-shield" description={t().accessDescription}>
                <PermissionsSection notebook={notebook()} />
              </SettingsModal.Tab>
              <SettingsModal.Tab
                id="api-keys"
                title={t().apiKeys}
                icon="ti ti-key"
                description={t().apiKeysDescription}
              >
                <ApiKeysSection notebook={notebook()} />
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().data}>
              <SettingsModal.Tab
                id="export"
                title={t().exportSnapshots}
                icon="ti ti-download"
                description={t().exportSnapshotsDescription}
              >
                <ExportSection notebook={notebook()} onDirtyChange={setExportDirty} />
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().lifecycle}>
              <SettingsModal.Tab
                id="danger"
                title={t().dangerZone}
                icon="ti ti-alert-triangle"
                description={t().dangerDescription}
                tone="danger"
              >
                <DangerZone notebook={notebook()} />
              </SettingsModal.Tab>
            </SettingsModal.Group>
          </>
        )}
      </SettingsModal>
    </div>
  );
}
