import type { CloudCliContext } from "@k2b/cloud/cli";
import { flag } from "@k2b/cloud/cli";
import type { PublicBase as Base, PublicForm, PublicTable as Table } from "../api/public-dto";
import { resolveBaseFromCommand, resolveNamedResource, resolveTable } from "./resources";
import { readApi } from "./runtime";

export type Form = Omit<PublicForm, "id"> & { id: string };

export const formFlag = {
  form: flag.string({ description: "Form public id or exact name" }),
};

export const listForms = (ctx: CloudCliContext, tableId: string): Promise<Form[]> =>
  readApi<Form[]>(ctx, `/forms/by-table/${encodeURIComponent(tableId)}`);

const resolveForm = async (ctx: CloudCliContext, table: Table | null, ref: string): Promise<Form> => {
  if (!table) throw new Error("Resolving a form requires --table because form names and ids are table-scoped.");
  return resolveNamedResource<Form>(await listForms(ctx, table.id), ref, "form");
};

export const formRows = (items: Form[]) =>
  items.map((form) => ({
    id: form.id,
    name: form.name,
    active: form.isActive ? "yes" : "no",
    public: form.publicToken ? "yes" : "no",
    fields:
      typeof form.config === "object" && form.config !== null && Array.isArray((form.config as { fields?: unknown }).fields)
        ? (form.config as { fields: unknown[] }).fields.length
        : 0,
    updatedAt: form.updatedAt,
  }));

export const resolveFormFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  refs: { table?: string; form?: string },
): Promise<{ base: Base; table: Table | null; form: Form }> => {
  const { base, rest } = await resolveBaseFromCommand(ctx, args, refs.table || refs.form ? 0 : 2);
  const table = refs.table
    ? await resolveTable(ctx, base.id, refs.table)
    : rest.length >= 2
      ? await resolveTable(ctx, base.id, rest[0]!)
      : null;
  const formRef = refs.form ?? (table ? rest[1] : rest[0]);
  if (!formRef) throw new Error("Missing form.");
  return { base, table, form: await resolveForm(ctx, table, formRef) };
};
