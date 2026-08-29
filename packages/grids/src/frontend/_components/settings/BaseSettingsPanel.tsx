import { confirmDiscardIfDirty, NoticeCard, SettingsGroup, SettingsModal, useLocale } from "@k2b/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { createSignal } from "solid-js";
import type { PublicBase } from "../../../api/public-dto";
import { DangerZone, DocumentDefaultsForm, GeneralForm, PermissionsSection, TrashSection } from "./BaseSettingsSections";
import { ControlledDestructionSection } from "./ControlledDestructionSection";
import { EvidenceExportsSection } from "./EvidenceExportsSection";
import { useGridsSettingsMessages } from "./messages";
import { PreservationHoldsSection } from "./PreservationHoldsSection";
import { RetentionPolicySection } from "./RetentionPolicySection";
import { TablesOverviewSection } from "./TablesOverviewSection";

type Props = {
  base: PublicBase;
  accessEntries: AccessEntry[];
  onClose?: () => void;
};

export default function BaseSettingsPanel(props: Props) {
  const locale = useLocale();
  const t = useGridsSettingsMessages(locale);
  const [activeTab, setActiveTab] = createSignal("general");
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const [saving, setSaving] = createSignal<Record<string, boolean>>({});
  const [navigationPending, setNavigationPending] = createSignal(false);
  let container: HTMLDivElement | undefined;
  const hasUnsavedChanges = () => Object.values(dirty()).some(Boolean);
  const savePending = () => Object.values(saving()).some(Boolean);
  const setSectionDirty = (section: string, value: boolean) =>
    setDirty((current) => (current[section] === value ? current : { ...current, [section]: value }));
  const setSectionSaving = (section: string, value: boolean) =>
    setSaving((current) => (current[section] === value ? current : { ...current, [section]: value }));
  const restoreActiveTabFocus = () =>
    setTimeout(() => container?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(), 0);

  const requestTabChange = async (nextTab: string) => {
    if (nextTab === activeTab()) return;
    if (navigationPending() || savePending()) {
      restoreActiveTabFocus();
      return;
    }
    setNavigationPending(true);
    try {
      if (!(await confirmDiscardIfDirty(hasUnsavedChanges)) || savePending()) {
        restoreActiveTabFocus();
        return;
      }
      setDirty({});
      setActiveTab(nextTab);
      restoreActiveTabFocus();
    } finally {
      setNavigationPending(false);
    }
  };

  const requestClose = async () => {
    if (navigationPending() || savePending()) return;
    setNavigationPending(true);
    try {
      if ((await confirmDiscardIfDirty(hasUnsavedChanges)) && !savePending()) props.onClose?.();
    } finally {
      setNavigationPending(false);
    }
  };

  return (
    <div ref={container} class="flex h-full min-h-0 flex-col overflow-hidden">
      <SettingsModal
        title={t().baseSettings}
        activeTab={activeTab()}
        onTabChange={(tab) => void requestTabChange(tab)}
        onClose={() => void requestClose()}
        closeLabel={t().closeSettings}
      >
        <SettingsModal.Group title={t().base}>
          <SettingsModal.Tab id="general" title={t().general} icon="ti ti-id" description={t().generalDescription}>
            <GeneralForm
              base={props.base}
              onDirtyChange={(value) => setSectionDirty("general", value)}
              onSavingChange={(value) => setSectionSaving("general", value)}
            />
          </SettingsModal.Tab>

          <SettingsModal.Tab id="tables" title={t().tables} icon="ti ti-table-options" description={t().tablesDescription}>
            <TablesOverviewSection baseId={props.base.id} />
          </SettingsModal.Tab>

          <SettingsModal.Tab id="documents" title={t().documents} icon="ti ti-file-type-pdf" description={t().documentsDescription}>
            <DocumentDefaultsForm
              base={props.base}
              onDirtyChange={(value) => setSectionDirty("documents", value)}
              onSavingChange={(value) => setSectionSaving("documents", value)}
            />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().sharing}>
          <SettingsModal.Tab id="access" title={t().access} icon="ti ti-shield" description={t().accessDescription}>
            <SettingsGroup title={t().baseAccess} description={t().immediateChanges}>
              <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
                <i class="ti ti-info-circle text-sm mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t().baseGrantExplanation}</span>
              </NoticeCard>
              <PermissionsSection baseId={props.base.id} initialEntries={props.accessEntries} />
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().recovery}>
          <SettingsModal.Tab id="trash" title={t().trash} icon="ti ti-trash" description={t().trashDescription}>
            <TrashSection baseId={props.base.id} />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={t().lifecycle}>
          <SettingsModal.Tab id="retention" title={t().retention} icon="ti ti-archive" description={t().retentionDescription}>
            <RetentionPolicySection
              baseId={props.base.id}
              onDirtyChange={(value) => setSectionDirty("retention", value)}
              onSavingChange={(value) => setSectionSaving("retention", value)}
            />
          </SettingsModal.Tab>
          <SettingsModal.Tab id="holds" title={t().preservationHolds} icon="ti ti-lock" description={t().preservationHoldsDescription}>
            <PreservationHoldsSection baseId={props.base.id} onSavingChange={(value) => setSectionSaving("holds", value)} />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="evidence"
            title={t().evidenceExports}
            icon="ti ti-package-export"
            description={t().evidenceExportsDescription}
          >
            <EvidenceExportsSection base={props.base} />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="destruction"
            title={t().controlledDestruction}
            icon="ti ti-trash-x"
            description={t().controlledDestructionDescription}
            tone="danger"
          >
            <ControlledDestructionSection
              baseId={props.base.id}
              baseName={props.base.name}
              onSavingChange={(value) => setSectionSaving("destruction", value)}
            />
          </SettingsModal.Tab>

          <SettingsModal.Tab
            id="danger"
            title={t().dangerZone}
            icon="ti ti-alert-triangle"
            description={t().dangerZoneDescription}
            tone="danger"
          >
            <SettingsGroup title={t().moveBaseToTrash} description={t().moveBaseGroupDescription}>
              <SettingsGroup.Action>
                <DangerZone
                  baseId={props.base.id}
                  baseName={props.base.name}
                  onSavingChange={(value) => setSectionSaving("danger", value)}
                />
              </SettingsGroup.Action>
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </SettingsModal>
    </div>
  );
}
