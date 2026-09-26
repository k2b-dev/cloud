import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import { type Form, formFlag, formRows, listForms, resolveFormFromCommand } from "./forms-support";
import { baseFlag, requirePublicId, resolveTableFromCommand, tableArgs, tableFlag } from "./resources";
import {
  applyDefined,
  JSON_BODY_INPUT,
  jsonRequest,
  type MessageResponse,
  printCliStructured,
  printJsonOrMessage,
  printJsonOrTable,
  readApi,
  readJsonInput,
} from "./runtime";

export const formCommands = [
  command("forms list", {
    summary: "List custom forms for a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { table } = await resolveTableFromCommand(ctx, args.args);
      const forms = await listForms(ctx, table.id);
      printJsonOrTable(ctx, forms, formRows(forms), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "active", label: "ACTIVE" },
        { key: "public", label: "PUBLIC" },
        { key: "fields", label: "FIELDS" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("forms default", {
    summary: "Show the virtual default form for a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { table } = await resolveTableFromCommand(ctx, args.args);
      const form = await readApi<Form>(ctx, `/forms/by-table/${encodeURIComponent(table.id)}/default`);
      if (!printCliStructured(ctx, form)) {
        ctx.print(`${form.name} (${form.id})`);
        ctx.print(`active: ${form.isActive ? "yes" : "no"}`);
        ctx.print(`id: ${form.id}`);
      }
    },
  }),
  command("forms get", {
    summary: "Show a form",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...formFlag },
    async run({ ctx, args, flags }) {
      const { form } = await resolveFormFromCommand(ctx, args.args, flags);
      if (!printCliStructured(ctx, form)) {
        ctx.print(`${form.name} (${form.id})`);
        ctx.print(`active: ${form.isActive ? "yes" : "no"}`);
        ctx.print(`public: ${form.publicToken ? "yes" : "no"}`);
        ctx.print(`id: ${form.id}`);
      }
    },
  }),
  command("forms create", {
    summary: "Create a custom form",
    description:
      "Form config fields use field public ids. Run `cld grids fields list <base>:<table>` and `cld grids records shape <base>:<table>` first.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Form name" }),
      config: flag.string({ description: "Form config JSON object" }),
      public: flag.boolean({ description: "Create with a public submit token" }),
      private: flag.boolean({ description: "Create without a public submit token" }),
    },
    examples: [
      'cld grids forms create Bookshop:Orders --name \'Checkout\' --config \'{"fields":[{"kind":"user_input","fieldId":"<field-id>"}]}\'',
      "cld grids forms create --base Bookshop --table Orders --body-file form.json",
    ],
    async run({ ctx, args, flags }) {
      const { table } = await resolveTableFromCommand(ctx, args.args);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "form JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        config: flags.config ? JSON.parse(flags.config) : undefined,
        isPublic: flags.public ? true : flags.private ? false : undefined,
      });
      if (!body.name) throw new Error("Missing form name. Pass --name or --body JSON.");
      const form = await readApi<Form>(ctx, `/forms/by-table/${encodeURIComponent(table.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, form, `Created form ${form.name} (${form.id}).`);
    },
  }),
  command("forms update", {
    summary: "Update a form",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...formFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Form name" }),
      config: flag.string({ description: "Form config JSON object" }),
      public: flag.boolean({ description: "Ensure the form has a public submit token" }),
      private: flag.boolean({ description: "Remove the public submit token" }),
      active: flag.boolean({ description: "Activate the form" }),
      inactive: flag.boolean({ description: "Deactivate the form" }),
      position: flag.int({ min: 0, description: "Form position" }),
    },
    async run({ ctx, args, flags }) {
      const { form } = await resolveFormFromCommand(ctx, args.args, flags);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "form update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        config: flags.config ? JSON.parse(flags.config) : undefined,
        isPublic: flags.public ? true : flags.private ? false : undefined,
        isActive: flags.active ? true : flags.inactive ? false : undefined,
        position: flags.position,
      });
      const updated = await readApi<Form>(ctx, `/forms/${encodeURIComponent(form.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated form ${updated.name} (${updated.id}).`);
    },
  }),
  command("forms delete", {
    summary: "Delete a form",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...formFlag, yes: confirmFlag("Delete this form") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { form } = await resolveFormFromCommand(ctx, args.args, flags);
      await readApi<MessageResponse>(ctx, `/forms/${encodeURIComponent(form.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: form.id }, `Deleted form ${form.name} (${form.id}).`);
    },
  }),
  command("forms restore", {
    summary: "Restore a deleted form by public id",
    args: { form: arg.required({ description: "Form public id" }) },
    async run({ ctx, args }) {
      const form = await readApi<Form>(ctx, `/forms/${encodeURIComponent(args.form)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, form, `Restored form ${form.name} (${form.id}).`);
    },
  }),
  command("forms submit", {
    summary: "Submit a form",
    description:
      "Pass field public IDs or {data,inlineCreates?,idempotencyKey?}. Reuse the exact body and key after an uncertain result. --record edits an existing record through the Form and requires --yes, version and idempotencyKey in the body; inlineUpdates use each child's recordId, version and data.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...formFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Existing Record public ID to edit instead of creating; requires --yes and a versioned body" }),
      yes: confirmFlag("Save the existing record through this form"),
    },
    examples: [
      'cld grids forms submit Bookshop:Orders Checkout --body \'{"<field-id>":"Ada"}\'',
      "cld grids forms submit --base Bookshop --table Orders --form Checkout --body-file submission.json",
      "cld grids forms submit --base Bookshop --table Orders --form Checkout --record REC001 --body-file edit.json --yes",
    ],
    async run({ ctx, args, flags }) {
      const recordId = flags.record === undefined ? undefined : requirePublicId(flags.record, "Record");
      if (recordId && !flags.yes) throw new Error("Pass --yes to save an existing record.");
      const { form } = await resolveFormFromCommand(ctx, args.args, flags);
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "form submission JSON", true);
      if (
        recordId &&
        (!Number.isInteger(body?.version) ||
          Number(body?.version) < 1 ||
          typeof body?.idempotencyKey !== "string" ||
          !body.idempotencyKey.trim())
      ) {
        throw new Error("Editing requires a positive version and an idempotencyKey in the submission body.");
      }
      const target = recordId ? `records/${encodeURIComponent(recordId)}` : "submit";
      const result = await readApi<{ recordId: string }>(ctx, `/forms/${encodeURIComponent(form.id)}/${target}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, result, `${recordId ? "Saved" : "Created"} record ${result.recordId}.`);
    },
  }),
];
