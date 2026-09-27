import type { DateContext } from "@k2b/stdlib";
import type { Accessor, Setter } from "solid-js";
import type { PublicField as Field, PublicForm as Form, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import type { FieldColumnSpec, RecordDisplayConfig, TableAuditPolicy, TableMutationPolicy } from "../../../contracts";
import {
  createFieldFromPrompt,
  deleteFieldWithChecks,
  openDocumentTemplatesDialog,
  openFormsDialog,
  openTableSettingsDialog,
} from "../dialogs/TableAdminDialogs";
import { openViewSettingsDialog } from "../dialogs/ViewSettingsDialogs";
import { openFieldEditDialog } from "../fields/TableFieldDialogs";
import { isFieldColumn, resolveDefaultViewColumns } from "./records-view-columns";

export const normalizeFieldOrder = (ordered: Field[]) => ordered.map((field, position) => ({ ...field, position }));

/** Mirrors the server: deleting a field clears it from the table's card and calendar settings. */
const withoutDisplayField = (config: RecordDisplayConfig, fieldId: string): RecordDisplayConfig => ({
  ...config,
  ...(config.cards
    ? {
        cards: {
          ...config.cards,
          ...(config.cards.imageFieldId === fieldId ? { imageFieldId: null } : {}),
          ...(config.cards.fieldIds ? { fieldIds: config.cards.fieldIds.filter((id) => id !== fieldId) } : {}),
        },
      }
    : {}),
  ...(config.calendar?.dateFieldId === fieldId ? { calendar: { ...config.calendar, dateFieldId: null } } : {}),
});

type RecordsAdminControllerOptions = {
  baseId: string;
  tableId: string;
  tableKind: "stored" | "federated";
  tableName: Accessor<string>;
  setTableName: Setter<string>;
  tableDescription: Accessor<string | null>;
  setTableDescription: Setter<string | null>;
  tableIcon: Accessor<string | null>;
  setTableIcon: Setter<string | null>;
  tableColumns: Accessor<FieldColumnSpec[]>;
  setTableColumns: Setter<FieldColumnSpec[]>;
  tableUpdatedAt: Accessor<string>;
  setTableUpdatedAt: Setter<string>;
  /** Re-reads the table's columns, version, and fields; see the column controller. */
  reloadTableColumns: () => Promise<boolean>;
  tableDisplayConfig: Accessor<RecordDisplayConfig>;
  setTableDisplayConfig: Setter<RecordDisplayConfig>;
  tableAuditPolicy: Accessor<TableAuditPolicy>;
  setTableAuditPolicy: Setter<TableAuditPolicy>;
  tableMutationPolicy: Accessor<TableMutationPolicy>;
  setTableMutationPolicy: Setter<TableMutationPolicy>;
  disableDirectInsert: Accessor<boolean>;
  setDisableDirectInsert: Setter<boolean>;
  fields: Accessor<Field[]>;
  setFields: Setter<Field[]>;
  /** Fields the current table view hides and "Add column" can show again. */
  hiddenFields: Accessor<Field[]>;
  showColumns: (fieldIds: string[]) => void;
  forms: Accessor<Form[]>;
  setForms: Setter<Form[]>;
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, Field[]>;
  activeView?: View | null;
  canEditActiveView?: boolean;
  canManageTable: boolean;
  canManageBase: boolean;
  dateConfig?: DateContext;
  refetch: () => void;
  setViewDisplayConfig: Setter<RecordDisplayConfig | null>;
};

export const createRecordsAdminController = (options: RecordsAdminControllerOptions) => {
  const syncFields = (next: Field[]) => {
    options.setFields([...next].sort((a, b) => a.position - b.position));
    options.refetch();
  };

  const tableHeader = () => ({
    kind: options.tableKind,
    baseId: options.baseId,
    id: options.tableId,
    name: options.tableName(),
    description: options.tableDescription(),
    icon: options.tableIcon(),
    columns: options.tableColumns(),
    displayConfig: options.tableDisplayConfig(),
    auditPolicy: options.tableAuditPolicy(),
    mutationPolicy: options.tableMutationPolicy(),
    disableDirectInsert: options.disableDirectInsert(),
  });

  const applyTableColumns = (table: Pick<Table, "columns" | "updatedAt">) => {
    options.setTableColumns(table.columns);
    options.setTableUpdatedAt(table.updatedAt);
  };

  const openFieldSettings = (field: Field) => {
    openFieldEditDialog({
      field,
      tableKind: options.tableKind,
      baseId: options.baseId,
      tableId: options.tableId,
      otherTables: options.otherTables,
      fieldsByTable: { ...options.fieldsByTable, [options.tableId]: options.fields() },
      tableColumns: () => ({
        // An empty table column list means "derive from the fields"; edit the list the table shows so a save keeps the other columns.
        columns: resolveDefaultViewColumns(options.tableColumns(), options.fields()).filter(isFieldColumn),
        derived: options.tableColumns().length === 0,
        updatedAt: options.tableUpdatedAt(),
      }),
      dateConfig: options.dateConfig,
      onSaved: (updated) => syncFields(options.fields().map((candidate) => (candidate.id === updated.id ? updated : candidate))),
      onTableColumnsSaved: applyTableColumns,
      onTableColumnsConflict: options.reloadTableColumns,
      onDeleted: async () => {
        const deleted = await deleteFieldWithChecks(field);
        if (!deleted) return false;
        // The server removes the field from the table's columns and display settings and changes the table version.
        options.setTableColumns((columns) => columns.filter((column) => column.fieldId !== field.id));
        options.setTableDisplayConfig((config) => withoutDisplayField(config, field.id));
        syncFields(options.fields().filter((candidate) => candidate.id !== field.id));
        // The editor stays open until the new version is known, so a column change right after it does not conflict.
        await options.reloadTableColumns();
        return true;
      },
    });
  };

  const openTableSettings = () => {
    openTableSettingsDialog({
      table: tableHeader(),
      fields: options.fields(),
      canManageBase: options.canManageBase,
      onSaved: (table) => {
        options.setTableName(table.name);
        options.setTableDescription(table.description ?? null);
        options.setTableIcon(table.icon ?? null);
        applyTableColumns(table);
        options.setTableDisplayConfig(table.displayConfig);
        options.setTableAuditPolicy(table.auditPolicy);
        options.setDisableDirectInsert(table.disableDirectInsert);
      },
      onMutationPolicySaved: (policy) => {
        options.setTableMutationPolicy(policy);
        // Saving the policy changes the table version that later column writes name.
        void options.reloadTableColumns();
      },
    });
  };

  const openAddField = async () => {
    const created = await createFieldFromPrompt({
      table: tableHeader(),
      hiddenFields: options.hiddenFields(),
      onShowHiddenField: (field) => options.showColumns([field.id]),
    });
    if (!created) return;
    // The server appends a new field to a stored column list and changes the table version; a derived list stays empty.
    if (!created.hideInTable && options.tableColumns().length > 0) {
      options.setTableColumns((columns) => [...columns, { fieldId: created.id }]);
    }
    syncFields(normalizeFieldOrder([...options.fields(), created]));
    await options.reloadTableColumns();
  };

  const openForms = () => {
    openFormsDialog({
      tableId: options.tableId,
      tableName: options.tableName(),
      fields: options.fields(),
      initialForms: options.forms(),
      onFormsChanged: (nextCustomForms) => {
        const defaults = options.forms().filter((form) => form.isDefault);
        options.setForms([...defaults, ...nextCustomForms]);
      },
    });
  };

  const openTemplates = () => {
    openDocumentTemplatesDialog({
      baseId: options.baseId,
      tableId: options.tableId,
      tableName: options.tableName(),
    });
  };

  const openViewSettings = () => {
    const view = options.activeView;
    if (!view || !options.canEditActiveView) return;
    openViewSettingsDialog({
      baseId: options.baseId,
      tableId: options.tableId,
      viewId: view.id,
      tableName: options.tableName(),
      initialView: view,
      fields: options.fields(),
      onSaved: (next) => {
        options.setViewDisplayConfig(next.ui.displayConfig ?? { mode: "table" });
        if (next.source !== view.source) window.location.reload();
      },
    });
  };

  return { openFieldSettings, openTableSettings, openAddField, openForms, openTemplates, openViewSettings };
};
