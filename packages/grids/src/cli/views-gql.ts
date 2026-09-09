import { arg, command, confirmFlag, flag, printStructured } from "@k2b/cloud/cli";
import type { PublicView as View } from "../api/public-dto";
import type { DslQueryAutocompleteResponse, DslQueryCompileViewResponse, DslQueryExecuteResponse } from "../contracts";
import { customAppContextKeys } from "../custom-apps/context-keys";
import { GRID_FORMULA_FUNCTIONS } from "../formula/function-catalog";
import { resolveCustomApp } from "./custom-apps";
import {
  baseArgs,
  baseFlag,
  resolveBaseFromCommand,
  resolveField,
  resolveTable,
  resolveTableFromFlags,
  tableArgs,
  tableFlag,
} from "./resources";
import {
  applyDefined,
  exactMatch,
  JSON_BODY_INPUT,
  jsonRequest,
  type MessageResponse,
  printAutocomplete,
  printCliStructured,
  printJsonOrMessage,
  printJsonOrTable,
  printReference,
  readApi,
  readApiText,
  readJsonInput,
  readTextInput,
  requireRestArg,
} from "./runtime";
import {
  collectGqlResultPages,
  displayValue,
  FORMULA_INPUT,
  FORMULA_REFERENCE,
  type FormulaPreviewResponse,
  GQL_INPUT,
  GQL_REFERENCE,
  listViews,
  printGqlDiagnostics,
  printGqlResult,
  readGql,
  resolveOptionalView,
  viewFlag,
  viewRows,
  writeOrPrint,
} from "./views-gql-support";

export const gqlCommands = [
  command("gql reference", {
    summary: "Show Grids Query Language syntax, refs, and examples",
    description:
      "This is the compact CLI reference. For a permission-safe base-specific assistant bundle, use `cld grids gql skill` and `cld grids gql context`.",
    examples: ["cld grids gql reference", "cld grids gql reference --json"],
    async run({ ctx }) {
      printReference(
        ctx,
        GQL_REFERENCE,
        [
          "Grids Query Language",
          "",
          "GQL is a line-oriented query language compiled by the Grids backend. Each query starts with from table/view.",
          "",
          "Clauses:",
          ...GQL_REFERENCE.clauses.map((item) => `  ${item}`),
          "",
          "References:",
          ...GQL_REFERENCE.refs.map((item) => `  ${item}`),
          "",
          "Execution:",
          ...GQL_REFERENCE.execution.map((item) => `  ${item}`),
          "",
          "Examples:",
          ...GQL_REFERENCE.examples.map((example) => `  ${example.replace(/\n/g, "\n  ")}`),
        ].join("\n"),
      );
    },
  }),
  command("gql run", {
    summary: "Execute a GQL query",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...viewFlag,
      query: GQL_INPUT,
      pageSize: flag.int({ name: "page-size", min: 1, max: 1000, description: "Rows in one result page" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      all: flag.boolean({ description: "Follow result cursors until the query ends or --max-rows is reached" }),
      maxRows: flag.int({ name: "max-rows", min: 1, max: 10_000, description: "Safety cap for --all (default: 10000)" }),
    },
    async run({ ctx, args, flags }) {
      if (flags.maxRows !== undefined && !flags.all) throw new Error("--max-rows requires --all.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = await resolveTableFromFlags(ctx, base, flags.table);
      const view = await resolveOptionalView(ctx, table, flags.view);
      const body = {
        query: await readGql(flags.query),
        ...(table ? { currentTableId: table.id, currentSource: { kind: "table", tableId: table.id } } : {}),
        ...(view
          ? {
              currentTableId: table ? table.id : view.tableId,
              currentSource: { kind: "view", viewId: view.id },
            }
          : {}),
      };
      const execute = (cursor: string | undefined, pageSize: number) =>
        readApi<DslQueryExecuteResponse>(
          ctx,
          `/gql/by-base/${encodeURIComponent(base.id)}/execute`,
          jsonRequest("POST", { ...body, pageSize, ...(cursor ? { cursor } : {}) }),
        );
      const pageSize = flags.pageSize ?? 100;
      if (!flags.all) return printGqlResult(ctx, await execute(flags.cursor, pageSize));

      return printGqlResult(
        ctx,
        await collectGqlResultPages(execute, { cursor: flags.cursor, maxRows: flags.maxRows ?? 10_000, pageSize }),
      );
    },
  }),
  command("gql preview", {
    summary: "Preview a GQL query with a smaller row cap",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...viewFlag,
      query: GQL_INPUT,
      limit: flag.int({ min: 1, max: 500, description: "Maximum preview rows" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = await resolveTableFromFlags(ctx, base, flags.table);
      const view = await resolveOptionalView(ctx, table, flags.view);
      const body = {
        query: await readGql(flags.query),
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        ...(table ? { currentTableId: table.id, currentSource: { kind: "table", tableId: table.id } } : {}),
        ...(view
          ? {
              currentTableId: table ? table.id : view.tableId,
              currentSource: { kind: "view", viewId: view.id },
            }
          : {}),
      };
      return printGqlResult(
        ctx,
        await readApi<DslQueryExecuteResponse>(ctx, `/gql/by-base/${encodeURIComponent(base.id)}/preview`, jsonRequest("POST", body)),
      );
    },
  }),
  command("gql compile-view", {
    summary: "Compile and canonicalize a GQL source for a saved view",
    args: baseArgs,
    flags: { ...baseFlag, ...tableFlag, ...viewFlag, query: GQL_INPUT },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = await resolveTableFromFlags(ctx, base, flags.table);
      const view = await resolveOptionalView(ctx, table, flags.view);
      const body = {
        query: await readGql(flags.query),
        ...(table ? { currentTableId: table.id, currentSource: { kind: "table", tableId: table.id } } : {}),
        ...(view
          ? {
              currentTableId: table ? table.id : view.tableId,
              currentSource: { kind: "view", viewId: view.id },
            }
          : {}),
      };
      const payload = await readApi<DslQueryCompileViewResponse>(
        ctx,
        `/gql/by-base/${encodeURIComponent(base.id)}/compile-view`,
        jsonRequest("POST", body),
      );
      if (printStructured(ctx, payload)) return payload.ok ? 0 : 1;
      if (!payload.ok) {
        printGqlDiagnostics(ctx, payload.diagnostics);
        return 1;
      }
      ctx.print(payload.source);
      return 0;
    },
  }),
  command("gql autocomplete", {
    summary: "Return permission-safe GQL autocomplete items",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...viewFlag,
      app: flag.string({ description: "App public id or exact name for page-context suggestions" }),
      page: flag.string({ description: "App page ID or exact title for page-context suggestions" }),
      query: GQL_INPUT,
      caret: flag.int({ min: 0, max: 20_000, description: "UTF-16 caret offset" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = await resolveTableFromFlags(ctx, base, flags.table);
      const view = await resolveOptionalView(ctx, table, flags.view);
      if (Boolean(flags.app) !== Boolean(flags.page)) throw new Error("--app and --page must be used together.");
      let contextKeys: ReturnType<typeof customAppContextKeys> | undefined;
      if (flags.app && flags.page) {
        const app = await resolveCustomApp(ctx, base.id, flags.app);
        if (!app.draftDefinition) throw new Error("App has no valid draft definition.");
        const page = exactMatch(
          app.draftDefinition.pages,
          flags.page,
          [(candidate) => candidate.id, (candidate) => candidate.title],
          "App page",
          (candidate) => `${candidate.title} (${candidate.id})`,
        );
        contextKeys = customAppContextKeys(page);
      }
      const body = {
        query: await readGql(flags.query),
        ...(flags.caret !== undefined ? { caret: flags.caret } : {}),
        ...(table ? { currentTableId: table.id, currentSource: { kind: "table", tableId: table.id } } : {}),
        ...(view
          ? {
              currentTableId: table ? table.id : view.tableId,
              currentSource: { kind: "view", viewId: view.id },
            }
          : {}),
        ...(contextKeys ? { contextKeys } : {}),
      };
      printAutocomplete(
        ctx,
        await readApi<DslQueryAutocompleteResponse>(
          ctx,
          `/gql/by-base/${encodeURIComponent(base.id)}/autocomplete`,
          jsonRequest("POST", body),
        ),
      );
    },
  }),
  command("gql skill", {
    summary: "Download the Grids GQL assistant SKILL.md",
    args: baseArgs,
    flags: { ...baseFlag, out: flag.string({ description: "Write to file instead of stdout" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      await writeOrPrint(ctx, await readApiText(ctx, `/gql/by-base/${encodeURIComponent(base.id)}/assistant/SKILL.md`), flags.out);
    },
  }),
  command("gql context", {
    summary: "Download permission-safe GQL schema context.md",
    args: baseArgs,
    flags: { ...baseFlag, out: flag.string({ description: "Write to file instead of stdout" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      await writeOrPrint(ctx, await readApiText(ctx, `/gql/by-base/${encodeURIComponent(base.id)}/assistant/context.md`), flags.out);
    },
  }),
];

export const formulaCommands = [
  command("formulas reference", {
    summary: "Show Grids formula syntax and function reference",
    description: "Formula fields, GQL predicates, computed columns, and parts of document/workflow authoring use this expression model.",
    examples: ["cld grids formulas reference", "cld grids formulas reference --json"],
    async run({ ctx }) {
      printReference(
        ctx,
        FORMULA_REFERENCE,
        [
          "Grids formulas",
          "",
          "Syntax:",
          ...FORMULA_REFERENCE.syntax.map((item) => `  ${item}`),
          "",
          "Common examples:",
          ...FORMULA_REFERENCE.examples.map((item) => `  ${item}`),
          "",
          "Functions:",
          ...GRID_FORMULA_FUNCTIONS.map((fn) => `  ${fn.signature} -> ${fn.returnType}: ${fn.description}`),
        ].join("\n"),
      );
    },
  }),
  command("formulas check", {
    summary: "Validate a formula and preview latest table records",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      expression: FORMULA_INPUT,
      currentField: flag.string({ name: "current-field", description: "Current formula field public id or exact name" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const expression = await readTextInput(flags.expression, "formula expression", true);
      const currentField = flags.currentField ? await resolveField(ctx, table.id, flags.currentField) : null;
      const payload = await readApi<FormulaPreviewResponse>(
        ctx,
        `/formulas/by-table/${encodeURIComponent(table.id)}/check`,
        jsonRequest("POST", applyDefined({ expression }, { currentFieldId: currentField ? currentField.id : undefined })),
      );
      if (ctx.options.output === "json") {
        ctx.json(payload);
        return payload.ok ? 0 : 1;
      }
      if (payload.diagnostics.length > 0) {
        for (const diagnostic of payload.diagnostics) ctx.print(`${diagnostic.severity}: ${diagnostic.message}`);
        ctx.print("");
      }
      if (payload.rows.length > 0) {
        ctx.table(
          payload.rows.map((row) => ({ recordId: row.recordId, result: displayValue(row.result) })),
          [
            { key: "recordId", label: "RECORD" },
            { key: "result", label: "RESULT" },
          ],
        );
      } else {
        ctx.print(payload.ok ? "Formula is valid." : "Formula has errors.");
      }
      return payload.ok ? 0 : 1;
    },
  }),
];

export const viewCommands = [
  command("views list", {
    summary: "List views for a table",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const views = await listViews(ctx, table.id);
      printJsonOrTable(ctx, views, viewRows(views), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "scope", label: "SCOPE" },
        { key: "updatedAt", label: "UPDATED" },
        { key: "id", label: "ID" },
      ]);
    },
  }),
  command("views get", {
    summary: "Show a view",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...viewFlag },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table || flags.view ? 0 : 2);
      const table = flags.table
        ? await resolveTable(ctx, base.id, flags.table)
        : rest.length >= 2
          ? await resolveTable(ctx, base.id, rest[0]!)
          : null;
      const view = flags.view
        ? await resolveOptionalView(ctx, table, flags.view)
        : await resolveOptionalView(ctx, table, table ? rest[1] : rest[0]);
      if (!view) throw new Error("Missing view.");
      if (!printCliStructured(ctx, view)) {
        ctx.print(`${view.name} (${view.id})`);
        ctx.print(`scope: ${view.ownerUserId ? "personal" : "shared"}`);
        ctx.print(`id: ${view.id}`);
        ctx.print("");
        ctx.print(view.source);
      }
    },
  }),
  command("views create", {
    summary: "Create a view",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "View name" }),
      description: flag.string({ description: "View description" }),
      icon: flag.string({ description: "View icon class" }),
      source: flag.string({ description: "GQL source" }),
      shared: flag.boolean({ description: "Create a shared view" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table ? 0 : 1);
      const table = await resolveTable(ctx, base.id, flags.table ?? requireRestArg(rest, 0, "table"));
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "view JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        icon: flags.icon,
        source: flags.source,
        shared: flags.shared ? true : undefined,
      });
      if (!body.name) throw new Error("Missing view name. Pass --name or --body JSON.");
      const view = await readApi<View>(ctx, `/views/by-table/${encodeURIComponent(table.id)}`, jsonRequest("POST", body));
      printJsonOrMessage(ctx, view, `Created view ${view.name} (${view.id}).`);
    },
  }),
  command("views update", {
    summary: "Update a view",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...viewFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "View name" }),
      description: flag.string({ description: "View description" }),
      source: flag.string({ description: "GQL source" }),
      shared: flag.boolean({ description: "Make the view shared" }),
      personal: flag.boolean({ description: "Make the view personal" }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table || flags.view ? 0 : 2);
      const table = flags.table
        ? await resolveTable(ctx, base.id, flags.table)
        : rest.length >= 2
          ? await resolveTable(ctx, base.id, rest[0]!)
          : null;
      const view = flags.view
        ? await resolveOptionalView(ctx, table, flags.view)
        : await resolveOptionalView(ctx, table, table ? rest[1] : rest[0]);
      if (!view) throw new Error("Missing view.");
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "view update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        source: flags.source,
        shared: flags.shared ? true : flags.personal ? false : undefined,
      });
      const updated = await readApi<View>(ctx, `/views/${encodeURIComponent(view.id)}`, jsonRequest("PATCH", body));
      printJsonOrMessage(ctx, updated, `Updated view ${updated.name} (${updated.id}).`);
    },
  }),
  command("views delete", {
    summary: "Delete a view",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...viewFlag, yes: confirmFlag("Delete this view") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, flags.table || flags.view ? 0 : 2);
      const table = flags.table
        ? await resolveTable(ctx, base.id, flags.table)
        : rest.length >= 2
          ? await resolveTable(ctx, base.id, rest[0]!)
          : null;
      const view = flags.view
        ? await resolveOptionalView(ctx, table, flags.view)
        : await resolveOptionalView(ctx, table, table ? rest[1] : rest[0]);
      if (!view) throw new Error("Missing view.");
      await readApi<MessageResponse>(ctx, `/views/${encodeURIComponent(view.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: view.id }, `Deleted view ${view.name} (${view.id}).`);
    },
  }),
  command("views restore", {
    summary: "Restore a deleted view by public id",
    args: { view: arg.required({ description: "View public id" }) },
    async run({ ctx, args }) {
      const view = await readApi<View>(ctx, `/views/${encodeURIComponent(args.view)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, view, `Restored view ${view.name} (${view.id}).`);
    },
  }),
];
