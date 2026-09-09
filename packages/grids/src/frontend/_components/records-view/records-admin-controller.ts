import type { DateContext } from "@k2b/stdlib";
import { prompts } from "@k2b/ui";
import type { Accessor, Setter } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field, PublicForm as Form, PublicView as View } from "../../../api/public-dto";
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
import { errorMessage } from "../utils/api-helpers";

export const normalizeFieldOrder = (ordered: Field[]) => ordered.map((field, position) => ({ ...field, position }));

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
  forms: Accessor<Form[]>;
  setForms: Setter<Form[]>;
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, Field[]>;
  activeView?: View | null;
  canEditActiveView?: boolean;
  canManageTable: boolean;
  canManageBase: boolean;
  dateConfig?: DateContext;
  fieldCreatedDisplayFailed: string;
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

  const openFieldSettings = (field: Field) => {
    openFieldEditDialog({
      field,
      tableKind: options.tableKind,
      baseId: options.baseId,
      tableId: options.tableId,
      otherTables: options.otherTables,
      fieldsByTable: { ...options.fieldsByTable, [options.tableId]: options.fields() },
      tableColumns: options.tableColumns(),
      dateConfig: options.dateConfig,
      onSaved: (updated) => syncFields(options.fields().map((candidate) => (candidate.id === updated.id ? updated : candidate))),
      onTableColumnsSaved: options.setTableColumns,
      onDeleted: async () => {
        const deleted = await deleteFieldWithChecks(field);
        if (deleted) syncFields(options.fields().filter((candidate) => candidate.id !== field.id));
        return deleted;
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
        options.setTableColumns(table.columns);
        options.setTableDisplayConfig(table.displayConfig);
        options.setTableAuditPolicy(table.auditPolicy);
        options.setDisableDirectInsert(table.disableDirectInsert);
      },
      onMutationPolicySaved: options.setTableMutationPolicy,
    });
  };

  const openAddField = async () => {
    const created = await createFieldFromPrompt({ table: tableHeader() });
    if (!created) return;
    syncFields(normalizeFieldOrder([...options.fields(), created]));
    if (
      created.hideInTable ||
      options.tableColumns().length === 0 ||
      options.tableColumns().some((column) => column.fieldId === created.id)
    ) {
      return;
    }
    const res = await apiClient.tables[":tableId"].$patch({
      param: { tableId: options.tableId },
      json: { columns: [...options.tableColumns(), { fieldId: created.id }] },
    });
    if (!res.ok) {
      prompts.error(await errorMessage(res, options.fieldCreatedDisplayFailed));
      return;
    }
    options.setTableColumns((await res.json()).columns);
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
