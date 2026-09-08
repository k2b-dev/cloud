import { type CustomAppDefinition, CustomAppDefinitionSchema, type CustomAppDiagnostic } from "./contracts";

export type CustomAppDefinitionResourceKind = "app" | "base" | "table" | "field" | "view" | "form" | "documentTemplate" | "launcher";

type CustomAppDefinitionV5MigrationLookup = {
  resolve: (kind: CustomAppDefinitionResourceKind, legacyId: string) => string | null;
  migrateGql?: (source: string) => string;
};

type CustomAppDefinitionV5Migration = { ok: true; definition: CustomAppDefinition } | { ok: false; diagnostics: CustomAppDiagnostic[] };

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

/** One-shot, path-aware v4 persistence migration. It is intentionally not used by the runtime parser. */
export const migrateCustomAppDefinitionV4 = (
  raw: unknown,
  lookup: CustomAppDefinitionV5MigrationLookup,
): CustomAppDefinitionV5Migration => {
  const root = object(structuredClone(raw));
  if (!root || root.schemaVersion !== 4 || root.kind !== "grids.custom-app") {
    return { ok: false, diagnostics: [{ path: ["schemaVersion"], message: "Expected a schemaVersion 4 Grids App definition" }] };
  }
  const diagnostics: CustomAppDiagnostic[] = [];
  const replace = (target: JsonObject, key: string, kind: CustomAppDefinitionResourceKind, path: Array<string | number>) => {
    const legacyId = target[key];
    if (typeof legacyId !== "string") return;
    const id = lookup.resolve(kind, legacyId);
    if (id) target[key] = id;
    else diagnostics.push({ path, message: `Cannot migrate unknown ${kind} id` });
  };
  const replaceArray = (target: JsonObject, key: string, kind: CustomAppDefinitionResourceKind, path: Array<string | number>) => {
    const values = target[key];
    if (!Array.isArray(values)) return;
    target[key] = values.map((legacyId, index) => {
      if (typeof legacyId !== "string") return legacyId;
      const id = lookup.resolve(kind, legacyId);
      if (id) return id;
      diagnostics.push({ path: [...path, index], message: `Cannot migrate unknown ${kind} id` });
      return legacyId;
    });
  };
  const replaceKeys = (target: JsonObject, key: string, kind: CustomAppDefinitionResourceKind, path: Array<string | number>) => {
    const values = object(target[key]);
    if (!values) return;
    target[key] = Object.fromEntries(
      Object.entries(values).map(([legacyId, value]) => {
        const id = lookup.resolve(kind, legacyId);
        if (!id) diagnostics.push({ path: [...path, legacyId], message: `Cannot migrate unknown ${kind} id` });
        return [id ?? legacyId, value];
      }),
    );
  };

  replace(root, "id", "app", ["id"]);
  replace(root, "baseId", "base", ["baseId"]);
  for (const [actionIndex, rawAction] of (Array.isArray(object(root.sidebar)?.actions)
    ? (object(root.sidebar)!.actions as unknown[])
    : []
  ).entries()) {
    const action = object(rawAction);
    if (!action || action.kind !== "form") continue;
    replace(action, "formId", "form", ["sidebar", "actions", actionIndex, "formId"]);
    replaceKeys(action, "fixedValues", "field", ["sidebar", "actions", actionIndex, "fixedValues"]);
    const availability = object(action.availableWhen);
    if (availability && typeof availability.query === "string" && lookup.migrateGql)
      availability.query = lookup.migrateGql(availability.query);
  }
  const pages = Array.isArray(root.pages) ? root.pages : [];
  for (const [pageIndex, rawPage] of pages.entries()) {
    const page = object(rawPage);
    if (!page) continue;
    const parameters = object(page.parameters);
    for (const [parameterId, rawParameter] of Object.entries(parameters ?? {})) {
      const parameter = object(rawParameter);
      if (parameter) replace(parameter, "tableId", "table", ["pages", pageIndex, "parameters", parameterId, "tableId"]);
    }
    const record = object(page.record);
    if (record) replace(record, "tableId", "table", ["pages", pageIndex, "record", "tableId"]);
    const availability = object(page.availableWhen);
    if (availability && typeof availability.query === "string" && lookup.migrateGql)
      availability.query = lookup.migrateGql(availability.query);
    for (const [rowIndex, rawRow] of (Array.isArray(page.rows) ? page.rows : []).entries()) {
      const row = object(rawRow);
      for (const [columnIndex, rawColumn] of (row && Array.isArray(row.columns) ? row.columns : []).entries()) {
        const column = object(rawColumn);
        for (const [blockIndex, rawBlock] of (column && Array.isArray(column.blocks) ? column.blocks : []).entries()) {
          const block = object(rawBlock);
          if (!block) continue;
          const path = ["pages", pageIndex, "rows", rowIndex, "columns", columnIndex, "blocks", blockIndex] as Array<string | number>;
          if (block.type === "comments" && typeof block.emptyText === "string") delete block.emptyText;
          const blockAvailability = object(block.availableWhen);
          if (blockAvailability && typeof blockAvailability.query === "string" && lookup.migrateGql)
            blockAvailability.query = lookup.migrateGql(blockAvailability.query);
          const source = object(block.source);
          if (source?.kind === "view") replace(source, "viewId", "view", [...path, "source", "viewId"]);
          if (source?.kind === "gql" && typeof source.query === "string" && lookup.migrateGql)
            source.query = lookup.migrateGql(source.query);
          if (block.type === "records") {
            const display = object(block.display);
            if (display?.kind === "table") replaceArray(display, "columnIds", "field", [...path, "display", "columnIds"]);
            const navigation = object(block.rowNavigate);
            const params = object(navigation?.params);
            for (const [parameterId, rawBinding] of Object.entries(params ?? {})) {
              const binding = object(rawBinding);
              if (binding?.path === "relation")
                replace(binding, "fieldId", "field", [...path, "rowNavigate", "params", parameterId, "fieldId"]);
            }
            for (const [index, rawAction] of (Array.isArray(block.rowActions) ? block.rowActions : []).entries()) {
              const action = object(rawAction);
              if (action) {
                replace(action, "launcherId", "launcher", [...path, "rowActions", index, "launcherId"]);
                const availability = object(action.availableWhen);
                if (availability && typeof availability.query === "string" && lookup.migrateGql)
                  availability.query = lookup.migrateGql(availability.query);
              }
            }
          } else if (block.type === "referenced_records") {
            replace(block, "sourceTableId", "table", [...path, "sourceTableId"]);
            replace(block, "relationFieldId", "field", [...path, "relationFieldId"]);
            replaceArray(block, "fieldIds", "field", [...path, "fieldIds"]);
            for (const [index, rawAction] of (Array.isArray(block.rowActions) ? block.rowActions : []).entries()) {
              const action = object(rawAction);
              if (action) {
                replace(action, "launcherId", "launcher", [...path, "rowActions", index, "launcherId"]);
                const availability = object(action.availableWhen);
                if (availability && typeof availability.query === "string" && lookup.migrateGql)
                  availability.query = lookup.migrateGql(availability.query);
              }
            }
          } else if (block.type === "record") {
            replaceArray(block, "fieldIds", "field", [...path, "fieldIds"]);
            replaceArray(block, "editableFieldIds", "field", [...path, "editableFieldIds"]);
            const documents = object(block.documents);
            if (documents) replaceArray(documents, "templateIds", "documentTemplate", [...path, "documents", "templateIds"]);
          } else if (block.type === "html") {
            replace(block, "fieldId", "field", [...path, "fieldId"]);
          } else if (block.type === "form") {
            replace(block, "formId", "form", [...path, "formId"]);
            replaceKeys(block, "fixedValues", "field", [...path, "fixedValues"]);
          } else if (block.type === "actions") {
            for (const [index, rawAction] of (Array.isArray(block.actions) ? block.actions : []).entries()) {
              const action = object(rawAction);
              if (action?.kind === "workflow") replace(action, "launcherId", "launcher", [...path, "actions", index, "launcherId"]);
              const availability = object(action?.availableWhen);
              if (availability && typeof availability.query === "string" && lookup.migrateGql)
                availability.query = lookup.migrateGql(availability.query);
            }
          } else if (block.type === "scanner") replace(block, "launcherId", "launcher", [...path, "launcherId"]);
        }
      }
    }
  }
  root.schemaVersion = 5;
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const parsed = CustomAppDefinitionSchema.safeParse(root);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : {
        ok: false,
        diagnostics: parsed.error.issues.map((issue) => ({
          path: issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
          message: issue.message,
        })),
      };
};
