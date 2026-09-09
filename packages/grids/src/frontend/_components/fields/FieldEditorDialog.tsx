import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  IconInput,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField } from "../../../api/public-dto";
import type { FieldColumnSpec, TableKind } from "../../../contracts";
import { effectiveDisplayField } from "../../../lookup-display";
import { ColumnFormatControls, type ColumnFormatControlsHandle } from "../dialogs/ViewColumnSettingsDialog";
import { FieldInput } from "../forms/form-fields";
import { errorMessage } from "../utils/api-helpers";
import { FieldOptionsSection } from "./FieldOptionsSection";
import { FieldConfigEditor, type FieldConfigState } from "./field-config-editor";
import { RECORD_INPUT_FIELD_TYPES } from "./field-render";
import { gridsFieldMessages } from "./messages";

const PRESENTABLE_TYPES = new Set(["text", "id", "number", "boolean", "date", "select", "percent", "duration"]);
const INDEXABLE_TYPES = new Set(["text", "longtext", "id", "number", "percent", "duration", "date", "boolean", "select", "principal"]);
const UNIQUE_TYPES = new Set(["text", "longtext", "id", "number", "percent", "date", "boolean"]);

// =============================================================================
// openFieldEditDialog — open FieldEditor inside a centered modal
// =============================================================================
//
// Previously the field editor expanded inline below each card. With many
// fields configured, the page grew to several screens tall and the user
// lost track of where they were while scrolling through configs. A modal
// gives clear focus, a fixed viewport, and a single visible thing at a
// time — matches Airtable's editing behavior.
//
// The dialog body re-uses the existing `FieldEditor` component verbatim;
// only the chrome (header, panel sizing, backdrop) lives here. Save /
// delete close the dialog after the parent's state-update callbacks
// fire, so the page list reflects the change immediately.

type OpenFieldEditArgs = {
  field: PublicField;
  tableKind: TableKind;
  baseId?: string;
  tableId?: string;
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, PublicField[]>;
  tableColumns?: FieldColumnSpec[];
  dateConfig?: DateContext;
  onSaved: (next: PublicField) => void;
  onTableColumnsSaved?: (columns: FieldColumnSpec[]) => void;
  onDeleted: () => Promise<boolean> | boolean;
};

export const openFieldEditDialog = (args: OpenFieldEditArgs): Promise<void> =>
  dialogCore.open<void>(
    (close, context) => <FieldEditDialog args={args} close={close} setDismissHandler={context.setDismissHandler} />,
    panelDialogOptions,
  );

function FieldEditDialog(props: { args: OpenFieldEditArgs; close: () => void; setDismissHandler: (handler: () => Promise<void>) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const [dirty, setDirty] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string>();
  const closeIfClean = async () => {
    if (pending()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  props.setDismissHandler(closeIfClean);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().editField({ name: props.args.field.name })}
        icon="ti ti-pencil"
        close={closeIfClean}
        closeDisabled={pending()}
      />
      <FieldEditor
        deleteError={deleteError()}
        deleting={pending()}
        field={props.args.field}
        tableKind={props.args.tableKind}
        baseId={props.args.baseId}
        tableId={props.args.tableId}
        otherTables={props.args.otherTables}
        fieldsByTable={props.args.fieldsByTable}
        tableColumns={props.args.tableColumns}
        dateConfig={props.args.dateConfig}
        onDirtyChange={setDirty}
        onPendingChange={setPending}
        onFieldSaved={props.args.onSaved}
        onSaved={(next) => {
          setDirty(false);
          props.close();
        }}
        onTableColumnsSaved={props.args.onTableColumnsSaved}
        onDeleted={async () => {
          if (pending()) return;
          setPending(true);
          setDeleteError(undefined);
          try {
            if (await props.args.onDeleted()) props.close();
          } catch (error) {
            setDeleteError(error instanceof Error ? error.message : t().deleteField);
          } finally {
            setPending(false);
          }
        }}
        onCancel={closeIfClean}
      />
    </PanelDialog>
  );
}

// =============================================================================
// FieldEditor — body of the field-edit modal
// =============================================================================

function FieldEditor(props: {
  field: PublicField;
  tableKind: TableKind;
  baseId?: string;
  tableId?: string;
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, PublicField[]>;
  tableColumns?: FieldColumnSpec[];
  dateConfig?: DateContext;
  onSaved: (next: PublicField) => void;
  onFieldSaved: (next: PublicField) => void;
  onPendingChange: (pending: boolean) => void;
  deleting: boolean;
  deleteError?: string;
  onTableColumnsSaved?: (columns: FieldColumnSpec[]) => void;
  onDeleted: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Optional cancel handler — only set when the editor is rendered
   *  inside a dialog. The footer adds a "Cancel" button next to Save
   *  so users have a clear way out without triggering a save. */
  onCancel?: () => void;
}) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const [name, setName] = createSignal(props.field.name);
  const [description, setDescription] = createSignal(props.field.description ?? "");
  const [icon, setIcon] = createSignal(props.field.icon ?? "");
  const [required, setRequired] = createSignal(props.field.required);
  const [presentable, setPresentable] = createSignal(props.field.presentable);
  const [hideInTable, setHideInTable] = createSignal(props.field.hideInTable);
  const [defaultValue, setDefaultValue] = createSignal<unknown>(props.field.defaultValue);
  const [dateDefaultMode, setDateDefaultMode] = createSignal<"none" | "fixed" | "now">(
    props.field.type === "date" &&
      typeof props.field.defaultValue === "object" &&
      props.field.defaultValue !== null &&
      (props.field.defaultValue as { kind?: unknown }).kind === "now"
      ? "now"
      : props.field.defaultValue === null || props.field.defaultValue === undefined
        ? "none"
        : "fixed",
  );
  const [indexed, setIndexed] = createSignal(props.field.indexed);
  const [uniqueConstraint, setUniqueConstraint] = createSignal(props.field.uniqueConstraint);
  const [config, setConfig] = createSignal<FieldConfigState>((props.field.config as FieldConfigState) ?? {});
  const initialColumn = () => props.tableColumns?.find((column) => column.fieldId === props.field.id);
  const [columnLabel, setColumnLabel] = createSignal(initialColumn()?.label ?? "");
  let formatControls: ColumnFormatControlsHandle | undefined;
  const [dirty, setDirty] = createSignal(false);
  const [displayFailed, setDisplayFailed] = createSignal(false);
  const [nameInvalid, setNameInvalid] = createSignal(false);
  const [savedField, setSavedField] = createSignal<{ payload: string; field: PublicField }>();
  let nameInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  const isCombined = () => props.tableKind === "federated";
  const supportsRequired = () => !isCombined() && RECORD_INPUT_FIELD_TYPES.has(props.field.type);
  const supportsDefaultValue = () => !isCombined() && RECORD_INPUT_FIELD_TYPES.has(props.field.type);
  const supportsPresentable = () => PRESENTABLE_TYPES.has(props.field.type);
  const supportsIndexed = () => !isCombined() && INDEXABLE_TYPES.has(props.field.type);
  const supportsUnique = () => !isCombined() && UNIQUE_TYPES.has(props.field.type);
  const forceUnique = () => !isCombined() && props.field.type === "id";

  // Touch-tracker — any field-level edit flips the dirty bit.
  const wrap =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setDirty(true);
      props.onDirtyChange?.(true);
    };

  const cleanColumn = (column: FieldColumnSpec): FieldColumnSpec => ({
    fieldId: column.fieldId,
    ...(column.label?.trim() ? { label: column.label.trim() } : {}),
    ...(column.format ? { format: column.format } : {}),
  });

  const buildNextTableColumns = (): FieldColumnSpec[] | undefined => {
    if (!props.tableColumns) return undefined;
    const nextColumn = cleanColumn({
      fieldId: props.field.id,
      label: columnLabel(),
      format: formatControls?.value(),
    });
    const next = props.tableColumns.filter((column) => column.fieldId !== props.field.id);
    if (!hideInTable()) {
      const existingIndex = props.tableColumns.findIndex((column) => column.fieldId === props.field.id);
      if (existingIndex >= 0) next.splice(existingIndex, 0, nextColumn);
      else next.push(nextColumn);
    }
    return next.map(cleanColumn);
  };

  const updateMut = mutations.create<{ field: PublicField; tableColumns?: FieldColumnSpec[] }, void>({
    mutation: async () => {
      setDisplayFailed(false);
      const payload = {
        name: name().trim(),
        description: description().trim() || null,
        icon: icon().trim() || null,
        required: supportsRequired() ? required() : false,
        presentable: supportsPresentable() ? presentable() : false,
        hideInTable: hideInTable(),
        defaultValue: supportsDefaultValue() ? defaultValue() : null,
        indexed: supportsIndexed() ? indexed() : false,
        uniqueConstraint: forceUnique() ? true : supportsUnique() ? uniqueConstraint() : false,
        config: config() as Record<string, unknown>,
      };
      const serialized = JSON.stringify(payload);
      let field = savedField()?.payload === serialized ? savedField()?.field : undefined;
      if (!field) {
        const res = await apiClient.fields[":fieldId"].$patch({ param: { fieldId: props.field.id }, json: payload });
        if (!res.ok) throw new Error(await errorMessage(res, t().saveFieldFailed));
        field = await res.json();
        setSavedField({ payload: serialized, field });
        props.onFieldSaved(field);
      }
      const nextTableColumns = buildNextTableColumns();
      if (!nextTableColumns) return { field };
      if (JSON.stringify(nextTableColumns) === JSON.stringify(props.tableColumns)) return { field };
      setDisplayFailed(true);
      const tableRes = await apiClient.tables[":tableId"].$patch({
        param: { tableId: props.field.tableId },
        json: { columns: nextTableColumns },
      });
      if (!tableRes.ok) throw new Error(await errorMessage(tableRes, t().saveTableDisplayFailed));
      const table = await tableRes.json();
      return { field, tableColumns: table.columns };
    },
    onSuccess: (next) => {
      setDirty(false);
      props.onDirtyChange?.(false);
      if (next.tableColumns) props.onTableColumnsSaved?.(next.tableColumns);
      props.onSaved(next.field);
    },
  });
  createEffect(() => props.onPendingChange(updateMut.loading()));

  const handleSave = () => {
    if (updateMut.loading() || props.deleting) return;
    if (!name().trim()) {
      setNameInvalid(true);
      nameInput?.focus();
      return;
    }
    updateMut.mutate(undefined);
  };

  const typeLabel = () => t().typeLabel({ type: props.field.type });
  const typeDescription = () => t().typeDescription({ type: props.field.type });

  return (
    <>
      <PanelDialog.Body>
        <Show when={props.deleteError}>{(error) => <NoticeCard tone="danger" title={error()} />}</Show>
        <Show when={updateMut.error()}>
          {(error) => (
            <NoticeCard
              tone="danger"
              title={displayFailed() ? t().fieldSavedDisplayFailed : t().saveFieldFailed}
              detail={error().message === t().saveFieldFailed ? undefined : error().message}
            />
          )}
        </Show>
        <fieldset disabled={updateMut.loading() || props.deleting} class="flex flex-col gap-4 min-w-0">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextInput
              label={t().name}
              ref={(element) => {
                nameInput = element;
              }}
              error={() => (nameInvalid() && !name().trim() ? t().nameRequired : undefined)}
              description={t().nameDescription}
              value={name}
              onValueChange={wrap(setName)}
              icon="ti ti-typography"
              required
            />
            <TextInput label={t().datatype} description={t().datatypeDescription} icon="ti ti-category" value={typeLabel} disabled />
          </div>

          <PanelDialog.Section
            title={t().typeSettings}
            subtitle={typeDescription() || t().typeSettingsDescription}
            icon="ti ti-adjustments"
          >
            <FieldConfigEditor
              currentFieldId={props.field.id}
              type={props.field.type}
              currentTableId={props.field.tableId}
              baseId={props.baseId}
              tableId={props.tableId}
              config={config}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
                props.onDirtyChange?.(true);
              }}
              otherTables={props.otherTables}
              fieldsByTable={props.fieldsByTable}
            />
            <Show when={props.field.type === "id" && props.field.numberSeries} keyed>
              {(series) => (
                <NoticeCard
                  tone={series.migrationNote ? "warning" : "info"}
                  role="status"
                  title={t().numberSeries}
                  detail={t().numberSeriesDetail({
                    assignment: series.assignment === "finalization" ? t().finalized : t().created,
                    last: series.lastValue,
                    next: series.preview ?? undefined,
                    note: series.migrationNote ?? undefined,
                  })}
                />
              )}
            </Show>
          </PanelDialog.Section>

          <FieldOptionsSection title={t().appearance} icon="ti ti-palette">
            <TextInput
              label={t().descriptionOptional}
              description={t().fieldDescriptionDescription}
              value={description}
              onValueChange={wrap(setDescription)}
              icon="ti ti-info-circle"
              multiline
              lines={2}
              placeholder={t().fieldDescriptionExample}
            />

            <IconInput
              label={t().iconOptional}
              value={icon}
              onValueChange={(value) => wrap(setIcon)(value ?? "")}
              placeholder={t().searchIcons}
            />
          </FieldOptionsSection>

          <FieldOptionsSection title={t().recordBehavior} description={t().recordBehaviorDescription} icon="ti ti-toggle-right">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <Show when={supportsRequired()}>
                <CheckboxCard
                  label={t().required}
                  description={t().requiredDescription}
                  icon="ti ti-asterisk"
                  value={required}
                  onValueChange={wrap(setRequired)}
                />
              </Show>
              <Show when={supportsPresentable()}>
                <CheckboxCard
                  label={t().recordLabel}
                  description={t().recordLabelDescription}
                  icon="ti ti-tag"
                  value={presentable}
                  onValueChange={wrap(setPresentable)}
                />
              </Show>
              <CheckboxCard
                label={t().hideInTable}
                description={t().hideInTableDescription}
                icon="ti ti-eye-off"
                value={hideInTable}
                onValueChange={wrap(setHideInTable)}
              />
              <Show when={supportsUnique()}>
                <CheckboxCard
                  label={t().uniqueValues}
                  description={forceUnique() ? t().generatedIdsUnique : t().duplicateValuesBlockSave}
                  icon="ti ti-fingerprint"
                  value={() => (forceUnique() ? true : uniqueConstraint())}
                  onValueChange={forceUnique() ? undefined : wrap(setUniqueConstraint)}
                  disabled={forceUnique()}
                />
              </Show>
            </div>
          </FieldOptionsSection>

          <Show when={supportsIndexed()}>
            <FieldOptionsSection title={t().queryPerformance} description={t().queryPerformanceDescription} icon="ti ti-bolt">
              <CheckboxCard
                label={t().indexed}
                description={t().indexedDescription}
                icon="ti ti-database-search"
                value={indexed}
                onValueChange={wrap(setIndexed)}
              />
            </FieldOptionsSection>
          </Show>

          <Show when={props.tableColumns}>
            <FieldOptionsSection title={t().tableDisplay} description={t().tableDisplayDescription} icon="ti ti-table">
              <TextInput
                label={t().tableColumnName}
                description={t().tableColumnNameDescription}
                value={columnLabel}
                onValueChange={wrap(setColumnLabel)}
                icon="ti ti-heading"
                clearable
              />
              <ColumnFormatControls
                field={effectiveDisplayField(
                  {
                    id: props.field.id,
                    tableId: props.field.tableId,
                    name: props.field.name,
                    icon: props.field.icon,
                    type: props.field.type,
                    config: config() as Record<string, unknown>,
                  },
                  props.fieldsByTable,
                )}
                currentFormat={initialColumn()?.format}
                expose={(handle) => {
                  formatControls = handle;
                }}
                onChange={() => {
                  setDirty(true);
                  props.onDirtyChange?.(true);
                }}
              />
            </FieldOptionsSection>
          </Show>

          <Show when={supportsDefaultValue()}>
            {/* Default value — fills records that don't supply this field on
            create. Renders via the shared FieldInput so the value editor
            matches the field type (NumberInput for number, Select
            for select, etc). Saved as `defaultValue` on the field
            row; null/undefined = no default. */}
            <FieldOptionsSection title={t().default} description={t().defaultDescription} icon="ti ti-file-plus">
              <Show
                when={props.field.type === "date"}
                fallback={
                  <FieldInput
                    field={{
                      ...props.field,
                      config: config() as Record<string, unknown>,
                    }}
                    entry={{
                      kind: "user_input",
                      fieldId: props.field.id,
                      required: false,
                    }}
                    value={defaultValue()}
                    onChange={(v) => wrap(setDefaultValue)(v)}
                    dateConfig={props.dateConfig}
                  />
                }
              >
                <Select
                  label={t().defaultValue}
                  value={dateDefaultMode}
                  onValueChange={(v) => {
                    const mode = (v as "none" | "fixed" | "now" | null) ?? "none";
                    setDateDefaultMode(mode);
                    wrap(setDefaultValue)(mode === "now" ? { kind: "now" } : mode === "none" ? null : null);
                  }}
                  options={[
                    { id: "none", label: t().none },
                    { id: "fixed", label: t().fixedDate },
                    {
                      id: "now",
                      label: (config() as { includeTime?: boolean }).includeTime ? t().currentDateTime : t().currentDate,
                    },
                  ]}
                />
                <Show when={dateDefaultMode() === "fixed"}>
                  <FieldInput
                    field={{
                      ...props.field,
                      config: config() as Record<string, unknown>,
                    }}
                    entry={{
                      kind: "user_input",
                      fieldId: props.field.id,
                      required: false,
                    }}
                    value={defaultValue()}
                    onChange={(v) => wrap(setDefaultValue)(v)}
                    dateConfig={props.dateConfig}
                  />
                </Show>
              </Show>
              <p class="text-[11px] text-dimmed leading-snug">{t().leaveDefaultEmpty}</p>
            </FieldOptionsSection>
          </Show>
        </fieldset>
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="text-red-500 hover:text-red-600"
          onClick={props.onDeleted}
          disabled={updateMut.loading() || props.deleting}
        >
          <i class="ti ti-trash" /> {t().deleteField}
        </Button>
        <div class="flex items-center gap-2">
          <Show when={props.onCancel}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => props.onCancel?.()}
              disabled={updateMut.loading() || props.deleting}
            >
              {t().cancel}
            </Button>
          </Show>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleSave}
            disabled={!dirty() || props.deleting}
            loading={updateMut.loading()}
            loadingLabel={t().savingField}
          >
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </>
  );
}
