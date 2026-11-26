import { refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { useToast } from "@k2b/ui/v2";
import { createMemo, createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field, PublicForm as Form, PublicGridRecord } from "../../../api/public-dto";
import { isUserEditable } from "../fields/field-prompt-schema";
import { openFormModal } from "../records/FormSubmitModal";
import { openRecordUpsertDialog } from "../records/RecordUpsertDialog";
import { toolbarMessages } from "../toolbar/messages";
import { errorMessage } from "../utils/api-helpers";

export type RecordCreateOptions = {
  baseId: () => string;
  tableId: () => string;
  tableName: () => string;
  fields: () => Field[];
  forms: () => Form[];
  canWrite: () => boolean;
  canDirectWrite: () => boolean;
  canSubmitForms: () => boolean;
  disableDirectInsert: () => boolean;
  onRecordCreated: (record: PublicGridRecord) => void;
  onRecordsChanged: () => void;
  dateConfig?: DateContext;
};

/**
 * How a person adds records to a table: directly through the record dialog, or through the table's active forms.
 * `blocked` names why adding is not possible here, for a disabled control that says so.
 */
export function createRecordCreate(options: RecordCreateOptions) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const toast = useToast();
  const [creating, setCreating] = createSignal(false);
  const activeForms = createMemo(() => (options.canSubmitForms() ? options.forms().filter((form) => form.isActive) : []));
  const direct = () => options.canWrite() && options.canDirectWrite() && !options.disableDirectInsert();
  const blocked = () =>
    options.canWrite() && !options.canDirectWrite() ? (options.canSubmitForms() ? t().activeFormRequired : t().changesUnavailable) : null;

  const save = async (payload: Record<string, unknown>) => {
    setCreating(true);
    try {
      const response = await apiClient.records["by-table"][":tableId"].$post({ param: { tableId: options.tableId() }, json: payload });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      options.onRecordCreated(await response.json());
    } finally {
      setCreating(false);
    }
  };

  const addRecord = async () => {
    const live = options.fields().filter((field) => !field.deletedAt);
    if (!live.some((field) => isUserEditable(field.type) || field.type === "relation")) {
      toast(t().noEditableFields, { status: "bad" });
      return;
    }
    await openRecordUpsertDialog({
      mode: "create",
      fields: live,
      baseId: options.baseId(),
      tableName: options.tableName(),
      dateConfig: options.dateConfig,
      onSubmit: save,
    });
  };

  const submitForm = (form: Form) =>
    openFormModal(form, options.fields(), { onSubmitted: options.onRecordsChanged ?? refreshCurrentPath, dateConfig: options.dateConfig });

  return { creating, activeForms, direct, blocked, addRecord, submitForm };
}
