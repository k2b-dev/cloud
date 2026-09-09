import type { CloudCliContext } from "@k2b/cloud/cli";
import { printStructured } from "@k2b/cloud/cli";
import type { PublicField as Field, PublicTable as Table } from "../api/public-dto";
import {
  COMPUTED_FIELD_TYPES,
  EXTERNAL_FIELD_TYPES,
  fieldTypeRegistry,
  LINK_FIELD_TYPES,
  RECORD_WRITABLE_FIELD_TYPES,
  SERVER_GENERATED_FIELD_TYPES,
  SYSTEM_FIELD_TYPES,
  VALUE_FIELD_TYPES,
} from "../field-types";
import { displayValue } from "./views-gql-support";

export type FieldDependentsResponse = { dependents: unknown[]; hasBlocking: boolean };

type FieldTypeReference = {
  type: string;
  kind: string;
  category: string;
  recordWritable: boolean;
  config: string;
  recordValue: string;
  notes: string;
};

type FieldReferenceDetails = Omit<FieldTypeReference, "type" | "kind" | "category" | "recordWritable">;

const EMPTY_CONFIG = "{}";

const FIELD_TYPE_DETAILS: Record<string, FieldReferenceDetails> = {
  text: {
    config: '{ "minLength": 1, "maxLength": 200, "regex": "^[A-Z]", "multiline": false }',
    recordValue: '"Ada Lovelace"',
    notes: "Single-line text by default. Empty string becomes null unless the field is required.",
  },
  longtext: {
    config: '{ "markdown": true, "maxLength": 5000 }',
    recordValue: '"Long text with line breaks"',
    notes: "Multiline text. Whitespace is preserved.",
  },
  number: {
    config: '{ "min": 0, "max": 1000, "precision": 12, "decimalPlaces": 2, "integerOnly": false, "unit": "EUR", "unitPosition": "suffix" }',
    recordValue: '"42.50"',
    notes: "Accepts strings or numbers and stores a canonical decimal string.",
  },
  boolean: {
    config: EMPTY_CONFIG,
    recordValue: "true",
    notes: 'Accepts booleans and common API encodings like "true", "false", 1, and 0.',
  },
  date: {
    config: '{ "includeTime": false, "min": "2026-01-01", "max": "2026-12-31" }',
    recordValue: '"2026-07-07"',
    notes: "Date-only fields use YYYY-MM-DD. With includeTime=true, send a timezone-aware ISO date-time.",
  },
  select: {
    config:
      '{ "multiple": false, "minSelected": 0, "maxSelected": 1, "options": [{ "id": "open", "label": "Open", "color": "blue", "description": "Ready" }] }',
    recordValue: '["open"]',
    notes: "Record values are arrays of option ids. Single select still uses an array with at most one id.",
  },
  principal: {
    config: '{ "cardinality": "multiple" }',
    recordValue: '[{ "type": "user", "id": "<user-uuid>" }, { "type": "group", "id": "<group-uuid>" }]',
    notes:
      "Stores Cloud users and groups as typed references. The server rejects identities outside the writing actor's discoverable account scope.",
  },
  percent: {
    config: '{ "range": "percent", "decimals": 2 }',
    recordValue: "42.5",
    notes: 'range "percent" accepts 0..100. range "fraction" accepts 0..1.',
  },
  duration: {
    config: '{ "unit": "seconds" }',
    recordValue: '"01:30:00"',
    notes: "Stores integer seconds. Accepts seconds, MM:SS, or HH:MM:SS.",
  },
  json: {
    config: EMPTY_CONFIG,
    recordValue: '{ "any": "json" }',
    notes: "Stores arbitrary JSON. Nested JSON paths are opaque to filter/sort.",
  },
  relation: {
    config: '{ "targetTableId": "<table-id>", "cardinality": "multiple" }',
    recordValue: '["<record-id>"]',
    notes: "Links records by public id. Use a single id string for single-cardinality fields if preferred.",
  },
  id: {
    config: '{ "strategy": "date_sequence", "prefix": "INV-", "padding": 5, "period": "year" }',
    recordValue: "(server generated)",
    notes:
      "Generated on record create. Sequence values use a durable atomic series, are never reused, and may have technical gaps. Strategies: sequence, date_sequence, short_code, random_code, uuid, uuidv7, and ulid. Do not send id fields in record payloads.",
  },
  formula: {
    config: '{ "expression": "LEN(Name)" }',
    recordValue: "(computed)",
    notes: "Read-only computed field. Uses the Grids formula engine.",
  },
  html_template: {
    config: '{ "template": "<h2>{{ record.data.FIELD1 }}</h2>", "css": "h2 { color: #1d4ed8; }" }',
    recordValue: "(rendered HTML)",
    notes:
      "Read-only Liquid output rendered from the current record and shared app, business, table, and date context. Reference record fields by public field id.",
  },
  lookup: {
    config: '{ "relationFieldId": "<field-id>", "targetFieldId": "<field-id>" }',
    recordValue: "(computed)",
    notes: "Read-only projection through a relation field.",
  },
  rollup: {
    config: '{ "relationFieldId": "<field-id>", "targetFieldId": "<field-id>", "agg": "sum" }',
    recordValue: "(computed)",
    notes: "Read-only relation aggregate. agg is one of count, sum, avg, min, max.",
  },
  created_at: {
    config: EMPTY_CONFIG,
    recordValue: "(system)",
    notes: "System timestamp projected from the record row.",
  },
  created_by: {
    config: EMPTY_CONFIG,
    recordValue: "(system)",
    notes: "System user reference projected from the record row.",
  },
  updated_at: {
    config: EMPTY_CONFIG,
    recordValue: "(system)",
    notes: "System timestamp projected from the record row.",
  },
  updated_by: {
    config: EMPTY_CONFIG,
    recordValue: "(system)",
    notes: "System user reference projected from the record row.",
  },
  file: {
    config: '{ "maxFiles": 10, "accept": ["image/png", "application/pdf"] }',
    recordValue: "(external file API)",
    notes: "File bytes are not written through records create/update. Use the dedicated file API/UI.",
  },
};

const fieldTypeCategory = (type: string): string => {
  if (type in VALUE_FIELD_TYPES) return "value";
  if (type in LINK_FIELD_TYPES) return "link";
  if (type in SERVER_GENERATED_FIELD_TYPES) return "server-generated";
  if (type in COMPUTED_FIELD_TYPES) return "computed";
  if (type in SYSTEM_FIELD_TYPES) return "system";
  if (type in EXTERNAL_FIELD_TYPES) return "external";
  return "unknown";
};

export const fieldTypeReferences = (): FieldTypeReference[] =>
  Object.keys(fieldTypeRegistry)
    .sort()
    .map((type) => {
      const definition = fieldTypeRegistry[type]!;
      const details = FIELD_TYPE_DETAILS[type] ?? {
        config: EMPTY_CONFIG,
        recordValue: "(unknown)",
        notes: "No CLI reference details are available for this field type.",
      };
      return {
        type,
        kind: definition.kind,
        category: fieldTypeCategory(type),
        recordWritable: type in RECORD_WRITABLE_FIELD_TYPES,
        ...details,
      };
    });

export const fieldTypeReference = (type: string): FieldTypeReference => {
  const exact = fieldTypeReferences().find((item) => item.type === type);
  if (exact) return exact;
  const candidates = Object.keys(fieldTypeRegistry)
    .filter((item) => item.includes(type.toLowerCase()))
    .slice(0, 5)
    .join(", ");
  throw new Error(`Unknown field type "${type}".${candidates ? ` Candidates: ${candidates}.` : ""}`);
};

export const printFieldTypeReference = (ctx: CloudCliContext, ref: FieldTypeReference) => {
  if (printStructured(ctx, ref)) return;
  ctx.print(`${ref.type} (${ref.category})`);
  ctx.print(`kind: ${ref.kind}`);
  ctx.print(`record writable: ${ref.recordWritable ? "yes" : "no"}`);
  ctx.print(`config: ${ref.config}`);
  ctx.print(`record value: ${ref.recordValue}`);
  ctx.print(`notes: ${ref.notes}`);
};

export const fieldTypeRows = (items: FieldTypeReference[]) =>
  items.map((item) => ({
    type: item.type,
    category: item.category,
    writable: item.recordWritable ? "yes" : "no",
    recordValue: item.recordValue,
    config: item.config,
  }));

const fieldConfig = (field: Field): Record<string, unknown> =>
  typeof field.config === "object" && field.config !== null && !Array.isArray(field.config)
    ? (field.config as Record<string, unknown>)
    : {};

const selectExampleValue = (field: Field): unknown => {
  const options = fieldConfig(field).options;
  if (!Array.isArray(options)) return ["<option-id>"];
  const first = options.find(
    (item): item is { id: string } => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
  );
  return first ? [first.id] : ["<option-id>"];
};

const relationExampleValue = (field: Field): unknown => (fieldConfig(field).cardinality === "single" ? "<record-id>" : ["<record-id>"]);

const fieldExampleValue = (field: Field): unknown => {
  if (field.defaultValue !== null && field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case "text":
      return "Text value";
    case "longtext":
      return "Long text value";
    case "number":
      return "42";
    case "boolean":
      return true;
    case "date":
      return fieldConfig(field).includeTime ? "2026-07-07T12:00:00.000Z" : "2026-07-07";
    case "select":
      return selectExampleValue(field);
    case "principal":
      return [{ type: "user", id: "<user-uuid>" }];
    case "percent":
      return 42.5;
    case "duration":
      return "01:30:00";
    case "json":
      return { value: true };
    case "relation":
      return relationExampleValue(field);
    default:
      return null;
  }
};

export const recordShapeForFields = (table: Table, fields: Field[]) => {
  const alive = fields.filter((field) => !field.deletedAt);
  const writable = table.kind === "stored" ? alive.filter((field) => field.type in RECORD_WRITABLE_FIELD_TYPES) : [];
  const readOnly = table.kind === "stored" ? alive.filter((field) => !(field.type in RECORD_WRITABLE_FIELD_TYPES)) : alive;
  const example = Object.fromEntries(writable.map((field) => [field.id, fieldExampleValue(field)]));
  return {
    table: { id: table.id, name: table.name, kind: table.kind },
    payload:
      table.kind === "stored"
        ? "Record create/update bodies are plain JSON objects keyed by field public id."
        : "Combined tables are read-only. Query or export their canonical fields instead of sending record payloads.",
    example,
    writableFields: writable.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      required: field.required,
      config: field.config,
      exampleValue: fieldExampleValue(field),
    })),
    readOnlyFields: readOnly.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
    })),
  };
};

export const printRecordShape = (ctx: CloudCliContext, shape: ReturnType<typeof recordShapeForFields>) => {
  if (printStructured(ctx, shape)) return;
  ctx.print(`Record payload for ${shape.table.name} (${shape.table.id})`);
  if (shape.table.kind === "federated") {
    ctx.print("Combined tables are read-only. Use GQL, views, Grids Apps, documents, workflows, or export to consume their data.");
    ctx.print("");
  }
  if (shape.table.kind === "stored") ctx.print("Use field public-id keys. Exact field names are lookup aids in CLI arguments only.");
  ctx.print("");
  ctx.print("Example body:");
  ctx.print(JSON.stringify(shape.example, null, 2));
  ctx.print("");
  ctx.print("Writable fields:");
  ctx.table(
    shape.writableFields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required ? "yes" : "no",
      key: field.id,
      example: displayValue(field.exampleValue),
    })),
    [
      { key: "name", label: "FIELD" },
      { key: "type", label: "TYPE" },
      { key: "required", label: "REQ" },
      { key: "key", label: "JSON KEY" },
      { key: "example", label: "EXAMPLE" },
    ],
  );
  if (shape.readOnlyFields.length > 0) {
    ctx.print("");
    ctx.print("Read-only fields:");
    ctx.table(
      shape.readOnlyFields.map((field) => ({ name: field.name, type: field.type, key: field.id })),
      [
        { key: "name", label: "FIELD" },
        { key: "type", label: "TYPE" },
        { key: "key", label: "ID" },
      ],
    );
  }
};

export const tableRows = (items: Table[]) =>
  items.map((table) => ({
    id: table.id,
    name: table.name,
    kind: table.kind === "federated" ? "combined" : "stored",
    fields: table.columns.length,
    updatedAt: table.updatedAt,
  }));

export const fieldRows = (items: Field[]) =>
  items.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    required: field.required ? "yes" : "no",
    presentable: field.presentable ? "yes" : "no",
  }));
