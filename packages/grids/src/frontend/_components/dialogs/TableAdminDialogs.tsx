import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  DetailPanel,
  dialogCore,
  IconButton,
  IconInput,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicFederatedSourcePublication, PublicField, PublicForm, PublicTable } from "../../../api/public-dto";
import type { TableMutationPolicy } from "../../../contracts";
import { createDraft } from "../editor-draft";
import { defaultConfigForType, TYPE_OPTIONS } from "../fields/field-config-editor";
import { FIELD_TYPE_ICONS } from "../fields/field-type-meta";
import { gridsFieldMessages } from "../fields/messages";
import type { TableHeader } from "../fields/TableFieldDialogs";
import FormsManager from "../forms/FormsManager";
import { errorMessage } from "../utils/api-helpers";
import { auditPolicySummary, openAuditPolicyDialog } from "./AuditPolicyDialog";
import { openFederatedTableDialog } from "./FederatedTableDialog";
import { openHistoryProtectionDialog } from "./HistoryProtectionDialog";
import { mutationPolicySummary, openMutationPolicyDialog } from "./MutationPolicyDialog";
import { gridsDialogMessages } from "./messages";
import { RecordDisplayConfigEditor } from "./RecordDisplayConfigEditor";

export { openDocumentTemplateEditorDialog, openDocumentTemplatesDialog } from "./DocumentTemplateDialogs";

const browserLocale = (): string => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en");

export const openTableSettingsDialog = (args: {
  table: TableHeader;
  fields: PublicField[];
  canManageBase: boolean;
  onSaved: (table: PublicTable) => void;
  onMutationPolicySaved: (policy: TableMutationPolicy) => void;
  onDeleted?: () => void;
}) => dialogCore.open<void>((close) => <TableSettingsDialog args={args} close={close} />, panelDialogOptions);

function TableSettingsDialog(props: {
  args: {
    table: TableHeader;
    fields: PublicField[];
    canManageBase: boolean;
    onSaved: (table: PublicTable) => void;
    onMutationPolicySaved: (policy: TableMutationPolicy) => void;
    onDeleted?: () => void;
  };
  close: () => void;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const [dirty, setDirty] = createSignal(false);
  const closeIfClean = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().tableSettings({ name: props.args.table.name })} icon="ti ti-settings" close={closeIfClean} />
      <TableSettingsBody
        table={props.args.table}
        fields={props.args.fields}
        canManageBase={props.args.canManageBase}
        onDirtyChange={setDirty}
        onSaved={(table) => {
          setDirty(false);
          props.args.onSaved(table);
        }}
        onMutationPolicySaved={props.args.onMutationPolicySaved}
        onDeleted={props.args.onDeleted}
        onCancel={closeIfClean}
      />
    </PanelDialog>
  );
}

export const createFieldFromPrompt = async (args: { table: TableHeader; locale?: string }): Promise<PublicField | null> => {
  const locale = args.locale ?? browserLocale();
  const { t } = gridsDialogMessages.resolve([locale]);
  const fieldT = gridsFieldMessages.resolve([locale]).t;
  const type = await chooseFieldType(args.table.kind, locale);
  if (!type) return null;

  const result = await prompts.form({
    title: t.addField({ type: fieldT.typeLabel({ type }) || t.field }),
    icon: FIELD_TYPE_ICONS[type] ?? "ti ti-plus",
    fields: {
      name: { type: "text", label: t.name, required: true, placeholder: t.fieldNameExample },
    },
    confirmText: t.create,
    size: "small",
  });
  if (!result) return null;
  const name = String(result.name).trim();
  const res = await apiClient.fields["by-table"][":tableId"].$post({
    param: { tableId: args.table.id },
    json: { name, type, config: defaultConfigForType(type) },
  });
  if (!res.ok) {
    prompts.error(await errorMessage(res, t.createFieldFailed));
    return null;
  }
  return res.json();
};

const CREATE_TYPE_OPTIONS = TYPE_OPTIONS.filter((type) => type.value !== "json");

const chooseFieldType = (tableKind: TableHeader["kind"], locale: string) =>
  dialogCore.open<string | null>((close) => {
    const { t } = gridsDialogMessages.resolve([locale]);
    const fieldT = gridsFieldMessages.resolve([locale]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t.chooseFieldType} icon="ti ti-plus" close={() => close(null)} />
        <PanelDialog.Body>
          <NoticeCard tone="info" title={t.chooseFieldStorage} detail={t.chooseFieldStorageDetail} />
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <For
              each={CREATE_TYPE_OPTIONS.filter(
                (type) => tableKind !== "federated" || !["lookup", "rollup", "html_template"].includes(type.value),
              )}
            >
              {(type) => (
                <button type="button" class="paper p-3 text-left hover:paper-highlighted transition" onClick={() => close(type.value)}>
                  <div class="flex items-start gap-3">
                    <span class="thumbnail flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--ui-surface-subtle)]">
                      <i class={`${FIELD_TYPE_ICONS[type.value] ?? "ti ti-database"} text-base text-dimmed`} />
                    </span>
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-primary">{fieldT.typeLabel({ type: type.value })}</div>
                      <div class="mt-1 truncate text-xs font-medium text-secondary">{t.fieldValueExample({ type: type.value })}</div>
                      <p class="mt-1 text-xs leading-snug text-dimmed">{t.fieldPickerDescription({ type: type.value })}</p>
                    </div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);

export const openFormsDialog = (args: {
  tableId: string;
  tableName: string;
  fields: PublicField[];
  initialForms: PublicForm[];
  onFormsChanged?: (forms: PublicForm[]) => void;
}) =>
  dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => gridsDialogMessages.resolve([locale()]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().formsFor({ table: args.tableName })} icon="ti ti-forms" close={() => close()} />
        <PanelDialog.Body>
          <FormsManager
            tableId={args.tableId}
            fields={args.fields}
            initialForms={args.initialForms}
            onFormsChanged={args.onFormsChanged}
            canManage
          />
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);

export const deleteFieldWithChecks = async (field: PublicField, locale = browserLocale()): Promise<boolean> => {
  const { t } = gridsDialogMessages.resolve([locale]);
  const depsRes = await apiClient.fields[":fieldId"].dependents.$get({ param: { fieldId: field.id } });
  if (depsRes.ok) {
    const deps = await depsRes.json();
    if (deps.hasBlocking) {
      const blockers = deps.dependents
        .filter((d) => d.blocking)
        .map((d) => `• ${d.type}: ${d.resourceName}`)
        .join("\n");
      prompts.error(t.deleteFieldBlocked({ blockers }));
      return false;
    }
  }
  const confirmed = await prompts.confirm(t.softDeleteFieldConfirm({ name: field.name }), {
    title: t.deleteFieldQuestion,
    variant: "danger",
    confirmText: t.delete,
  });
  if (!confirmed) return false;
  const res = await apiClient.fields[":fieldId"].$delete({ param: { fieldId: field.id } });
  if (res.status >= 400) {
    prompts.error(await errorMessage(res, t.deleteFieldFailed));
    return false;
  }
  return true;
};

function TableSettingsBody(props: {
  table: TableHeader;
  fields: PublicField[];
  canManageBase: boolean;
  onSaved: (table: PublicTable) => void;
  onMutationPolicySaved: (policy: TableMutationPolicy) => void;
  onDeleted?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const draft = createDraft({
    name: props.table.name,
    description: props.table.description ?? "",
    icon: props.table.icon ?? "",
    displayConfig: props.table.displayConfig,
    auditPolicy: props.table.auditPolicy,
    disableDirectInsert: props.table.disableDirectInsert,
  });
  const patch = (partial: Partial<ReturnType<typeof draft.draft>>) => {
    draft.patch(partial);
    props.onDirtyChange?.(true);
  };
  const name = () => draft.draft().name;
  const description = () => draft.draft().description;
  const icon = () => draft.draft().icon;
  const displayConfig = () => draft.draft().displayConfig;
  const auditPolicy = () => draft.draft().auditPolicy;
  const disableDirectInsert = () => draft.draft().disableDirectInsert;
  const [publications, setPublications] = createSignal<PublicFederatedSourcePublication[]>([]);
  const [publicationsLoading, setPublicationsLoading] = createSignal(false);
  const [mutationPolicy, setMutationPolicy] = createSignal(props.table.mutationPolicy);

  const loadPublications = async () => {
    if (props.table.kind !== "stored" || !props.canManageBase) return;
    setPublicationsLoading(true);
    try {
      const response = await apiClient.tables[":tableId"].federation.publications.$get({ param: { tableId: props.table.id } });
      if (!response.ok) throw new Error(await errorMessage(response, t().publicationsLoadFailed));
      setPublications(await response.json());
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().publicationsLoadFailed);
    } finally {
      setPublicationsLoading(false);
    }
  };
  onMount(() => {
    void loadPublications();
  });

  const revokePublication = async (publication: PublicFederatedSourcePublication) => {
    const confirmed = await prompts.confirm(
      t().revokePublicationConfirm({ table: props.table.name, target: publication.targetTableName }),
      { title: t().revokePublicationQuestion, variant: "danger", confirmText: t().revoke },
    );
    if (!confirmed) return;
    const response = await apiClient.tables[":tableId"].federation.sources[":sourceTableId"].revoke.$post({
      param: { tableId: publication.targetTableId, sourceTableId: props.table.id },
    });
    if (!response.ok) return prompts.error(await errorMessage(response, t().revokePublicationFailed));
    await loadPublications();
  };

  const saveMut = mutations.create<PublicTable, void>({
    mutation: async () => {
      const trimmed = name().trim();
      if (!trimmed) throw new Error(t().tableNameRequired);
      const res = await apiClient.tables[":tableId"].$patch({
        param: { tableId: props.table.id },
        json: {
          name: trimmed,
          description: description().trim() || null,
          icon: icon() || null,
          displayConfig: displayConfig(),
          auditPolicy: auditPolicy(),
          disableDirectInsert: disableDirectInsert(),
        },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().saveTableFailed));
      return res.json();
    },
    onSuccess: (next) => {
      draft.markSaved({
        name: next.name,
        description: next.description ?? "",
        icon: next.icon ?? "",
        displayConfig: next.displayConfig,
        auditPolicy: next.auditPolicy,
        disableDirectInsert: next.disableDirectInsert,
      });
      props.onDirtyChange?.(false);
      props.onSaved(next);
    },
    onError: (e) => prompts.error(e.message),
  });

  const deleteMut = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.tables[":tableId"].$delete({ param: { tableId: props.table.id } });
      if (res.status >= 400) throw new Error(await errorMessage(res, t().deleteTableFailed));
    },
    onSuccess: () => {
      props.onDeleted?.();
      navigateTo(`/app/grids/${props.table.baseId}`);
    },
    onError: (e) => prompts.error(e.message),
  });

  const deleteTable = async () => {
    const ok = await prompts.confirm(t().deleteTableConfirm({ name: name() }), {
      title: t().deleteTableQuestion,
      variant: "danger",
      confirmText: t().delete,
    });
    if (ok) deleteMut.mutate(undefined);
  };

  const configureAudit = async () => {
    const next = await openAuditPolicyDialog({
      tableName: name(),
      fields: props.fields,
      value: auditPolicy(),
    });
    if (next) patch({ auditPolicy: next });
  };

  const configureMutationPolicy = async () => {
    const next = await openMutationPolicyDialog({
      tableId: props.table.id,
      tableName: name(),
      value: mutationPolicy(),
    });
    if (!next) return;
    setMutationPolicy(next);
    props.onMutationPolicySaved(next);
  };

  return (
    <>
      <PanelDialog.Body>
        <PanelDialog.Section title={t().identity} subtitle={t().identityDetail} icon="ti ti-id">
          <TextInput label={t().name} value={name} onValueChange={(v) => patch({ name: v })} icon="ti ti-typography" required />
          <IconInput
            label={t().icon}
            value={() => icon() ?? null}
            onValueChange={(v) => patch({ icon: v ?? undefined })}
            placeholder={t().searchIcons}
          />
          <TextInput
            label={t().description}
            value={description}
            onValueChange={(v) => patch({ description: v })}
            icon="ti ti-align-left"
            multiline
            lines={2}
            placeholder={t().optional}
          />
          <Show when={props.table.kind === "stored"}>
            <CheckboxCard
              label={t().addThroughForms}
              description={t().addThroughFormsDetail}
              icon="ti ti-forms"
              variant="input"
              value={disableDirectInsert}
              onValueChange={(v) => patch({ disableDirectInsert: v })}
            />
          </Show>
        </PanelDialog.Section>

        <PanelDialog.Section title={t().display} subtitle={t().tableDisplayDetail} icon="ti ti-layout">
          <RecordDisplayConfigEditor
            value={displayConfig}
            onChange={(value) => patch({ displayConfig: value })}
            fields={() => props.fields}
          />
        </PanelDialog.Section>

        <Show when={props.table.kind === "federated" && props.canManageBase}>
          <PanelDialog.Section title={t().combinedData} subtitle={t().combinedDataDetail} icon="ti ti-table-share">
            <button
              type="button"
              class="paper flex w-full items-center gap-3 p-3 text-left hover:paper-highlighted"
              onClick={() => void openFederatedTableDialog({ tableId: props.table.id, tableName: name(), targetFields: props.fields })}
            >
              <i class="ti ti-table-share text-lg text-dimmed" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-primary">{t().configureSources}</span>
                <span class="block text-xs text-dimmed">{t().configureSourcesDetail}</span>
              </span>
              <i class="ti ti-chevron-right text-dimmed" aria-hidden="true" />
            </button>
          </PanelDialog.Section>
        </Show>

        <Show when={props.table.kind === "stored" && props.canManageBase && (publicationsLoading() || publications().length > 0)}>
          <PanelDialog.Section title={t().combinedPublications} subtitle={t().combinedPublicationsDetail} icon="ti ti-database-share">
            <Show when={!publicationsLoading()} fallback={<Placeholder state="loading" align="left" title={t().loadingPublications} />}>
              <For each={publications()}>
                {(publication) => (
                  <div class="paper flex items-center gap-3 p-3">
                    <i class="ti ti-table-share text-lg text-dimmed" aria-hidden="true" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-medium text-primary">{publication.targetTableName}</div>
                      <div class="truncate text-xs text-dimmed">
                        {t().publicationMeta({
                          base: publication.targetBaseName,
                          revision: publication.revision,
                          count: publication.mappings.length,
                        })}
                      </div>
                      <div class="mt-2 flex flex-wrap gap-1">
                        <For each={publication.mappings}>
                          {(mapping) => (
                            <span class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs text-secondary">
                              {mapping.sourceFieldName} <i class="ti ti-arrow-right mx-1" aria-hidden="true" /> {mapping.targetFieldName}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                    <span class={publication.revokedAt ? "text-xs text-danger" : "text-xs text-secondary"}>
                      {publication.revokedAt ? t().revoked : publication.status === "active" ? t().active : t().actionRequired}
                    </span>
                    <Show when={!publication.revokedAt}>
                      <Tooltip.Anchor content={t().revokePublication}>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          class="text-danger"
                          label={t().revokePublicationTo({ table: publication.targetTableName })}
                          onClick={() => void revokePublication(publication)}
                        >
                          <i class="ti ti-unlink" aria-hidden="true" />
                        </IconButton>
                      </Tooltip.Anchor>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </PanelDialog.Section>
        </Show>

        <Show when={props.table.kind === "stored"}>
          <PanelDialog.Section title={t().dataIntegrity} subtitle={t().dataIntegrityDetail} icon="ti ti-shield-check">
            <div class="flex flex-col gap-1">
              <DetailPanel.Action
                type="button"
                onClick={() => void configureAudit()}
                leading={<i class="ti ti-shield-check" aria-hidden="true" />}
                title={t().tableAuditRequirements}
                description={auditPolicySummary(auditPolicy(), locale())}
                trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
              />
              <Show when={props.canManageBase}>
                <DetailPanel.Action
                  type="button"
                  onClick={() => void configureMutationPolicy()}
                  leading={<i class="ti ti-route" aria-hidden="true" />}
                  title={t().recordChanges}
                  description={mutationPolicySummary(mutationPolicy(), locale())}
                  trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                />
                <DetailPanel.Action
                  type="button"
                  onClick={() => void openHistoryProtectionDialog({ tableId: props.table.id, tableName: name() })}
                  leading={<i class="ti ti-history" aria-hidden="true" />}
                  title={t().historyProtection}
                  description={t().historyProtectionDetail}
                  trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                />
              </Show>
            </div>
          </PanelDialog.Section>
        </Show>

        <PanelDialog.Section title={t().dangerZone} subtitle={t().tableDangerDetail} icon="ti ti-trash">
          <Button variant="danger" size="sm" type="button" class="self-start" onClick={deleteTable} disabled={deleteMut.loading()}>
            <i class="ti ti-trash" /> {t().deleteTable}
          </Button>
        </PanelDialog.Section>
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <span />
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={props.onCancel}>
            {t().cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => saveMut.mutate(undefined)}
            disabled={!draft.dirty()}
            loading={saveMut.loading()}
            loadingLabel={t().savingTable}
          >
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </>
  );
}
