import type { GridRecord } from "../contracts";
import type { CustomAppFormValueBinding, CustomAppPage, CustomAppRowValueBinding, CustomAppValueBinding } from "./contracts";

type CustomAppBindingContext = {
  parameterRecords: ReadonlyMap<string, GridRecord>;
  pageRecord?: GridRecord;
  rowRecordId?: string;
  currentUserId?: string;
};

export const customAppBindingRecordTableId = (
  binding: CustomAppRowValueBinding | CustomAppFormValueBinding,
  page: CustomAppPage,
  rowTableId?: string,
): string | null => {
  if (binding.source === "PARAMS") return page.parameters[binding.path]?.tableId ?? null;
  if (binding.source === "RECORD") return page.record?.tableId ?? null;
  if (binding.source === "ROW") return rowTableId ?? null;
  return null;
};

export const resolveCustomAppValueBinding = (
  binding: CustomAppValueBinding | CustomAppRowValueBinding | CustomAppFormValueBinding,
  context: CustomAppBindingContext,
): { ok: true; value: unknown } | { ok: false } => {
  if (binding.source === "LITERAL") return { ok: true, value: binding.value };
  if (binding.source === "AUTH") {
    return context.currentUserId ? { ok: true, value: [{ type: "user", id: context.currentUserId }] } : { ok: false };
  }
  if (binding.source === "PARAMS") {
    const record = context.parameterRecords.get(binding.path);
    return record ? { ok: true, value: record.id } : { ok: false };
  }
  if (binding.source === "RECORD") return context.pageRecord ? { ok: true, value: context.pageRecord.id } : { ok: false };
  return context.rowRecordId ? { ok: true, value: context.rowRecordId } : { ok: false };
};
