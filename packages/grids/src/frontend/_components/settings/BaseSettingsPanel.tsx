import { confirmDiscardIfDirty, NoticeCard, SettingsGroup, SettingsModal } from "@k2b/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { createSignal } from "solid-js";
import type { PublicBase } from "../../../api/public-dto";
import { DangerZone, DocumentDefaultsForm, GeneralForm, PermissionsSection, TrashSection } from "./BaseSettingsSections";
import { ControlledDestructionSection } from "./ControlledDestructionSection";
import { EvidenceExportsSection } from "./EvidenceExportsSection";
import { PreservationHoldsSection } from "./PreservationHoldsSection";
import { RetentionPolicySection } from "./RetentionPolicySection";
import { TablesOverviewSection } from "./TablesOverviewSection";

type Props = {
  base: PublicBase;
  accessEntries: AccessEntry[];
  onClose?: () => void;
};

export default function BaseSettingsPanel(props: Props) {
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
        title="Base settings"
        activeTab={activeTab()}
        onTabChange={(tab) => void requestTabChange(tab)}
        onClose={() => void requestClose()}
        closeLabel="Close settings"
      >
        <SettingsModal.Group title="Base">
          <SettingsModal.Tab id="general" title="General" icon="ti ti-id" description="Identity shown across Grids.">
            <GeneralForm
              base={props.base}
              onDirtyChange={(value) => setSectionDirty("general", value)}
              onSavingChange={(value) => setSectionSaving("general", value)}
            />
          </SettingsModal.Tab>

          <SettingsModal.Tab
            id="tables"
            title="Tables"
            icon="ti ti-table-options"
            description="Review Table structure, write paths, and evidence protections."
          >
            <TablesOverviewSection baseId={props.base.id} />
          </SettingsModal.Tab>

          <SettingsModal.Tab
            id="documents"
            title="Documents"
            icon="ti ti-file-type-pdf"
            description="Business details used by generated documents."
          >
            <DocumentDefaultsForm
              base={props.base}
              onDirtyChange={(value) => setSectionDirty("documents", value)}
              onSavingChange={(value) => setSectionSaving("documents", value)}
            />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title="Sharing">
          <SettingsModal.Tab id="access" title="Access" icon="ti ti-shield" description="People with direct access to all Base data.">
            <SettingsGroup title="Base access" description="Changes apply immediately.">
              <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
                <i class="ti ti-info-circle text-sm mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  A Base grant applies to every table, view, form, document template, and workflow. Apps use independent grants for narrower
                  audiences.
                </span>
              </NoticeCard>
              <PermissionsSection baseId={props.base.id} initialEntries={props.accessEntries} />
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title="Recovery">
          <SettingsModal.Tab id="trash" title="Trash" icon="ti ti-trash" description="Deleted structures that can still be restored.">
            <TrashSection baseId={props.base.id} />
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title="Lifecycle">
          <SettingsModal.Tab
            id="retention"
            title="Retention"
            icon="ti ti-archive"
            description="Keep deleted Records and unreferenced Files recoverable for a minimum time—for example, through an internal review period."
          >
            <RetentionPolicySection
              baseId={props.base.id}
              onDirtyChange={(value) => setSectionDirty("retention", value)}
              onSavingChange={(value) => setSectionSaving("retention", value)}
            />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="holds"
            title="Preservation holds"
            icon="ti ti-lock"
            description="Pause future destruction for a Base or Table—for example, while a complaint or audit is being resolved."
          >
            <PreservationHoldsSection baseId={props.base.id} onSavingChange={(value) => setSectionSaving("holds", value)} />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="evidence"
            title="Evidence exports"
            icon="ti ti-package-export"
            description="Create a verifiable snapshot of available Records and artifacts—for example, to hand a review package to an auditor."
          >
            <EvidenceExportsSection base={props.base} />
          </SettingsModal.Tab>
          <SettingsModal.Tab
            id="destruction"
            title="Controlled destruction"
            icon="ti ti-trash-x"
            description="Permanently remove eligible unreferenced File bytes—for example, after an approved retention period has ended."
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
            title="Danger zone"
            icon="ti ti-alert-triangle"
            description="Move this Base and its contents out of active use."
            tone="danger"
          >
            <SettingsGroup
              title="Move Base to trash"
              description="The Base disappears from normal use but remains restorable by an administrator."
            >
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
