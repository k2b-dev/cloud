import { booleanHandler } from "./boolean";
import { dateHandler } from "./date";
import { formulaHandler } from "./formula";
import { htmlTemplateHandler } from "./html-template";
import { numberHandler } from "./number";
import { objectListHandler } from "./object-list";
import { principalHandler } from "./principal";
import { lookupHandler, relationHandler, rollupHandler } from "./relations";
import { resourceHandler } from "./resource";
import { selectHandler } from "./select";
import { createdAtHandler, createdByHandler, idHandler, updatedAtHandler, updatedByHandler } from "./system";
import { longtextHandler, textHandler } from "./text";
import { durationHandler, percentHandler } from "./tier2";
import { fileHandler, jsonHandler } from "./tier3";
import type {
  ComputedFieldKind,
  ExternalFieldKind,
  FieldTypeDefinition,
  LinkFieldType,
  RecordWritableFieldType,
  ServerGeneratedFieldKind,
  SystemFieldKind,
  ValueFieldType,
} from "./types";

export const VALUE_FIELD_TYPES: Record<string, ValueFieldType> = Object.fromEntries(
  [
    textHandler,
    longtextHandler,
    numberHandler,
    objectListHandler,
    booleanHandler,
    dateHandler,
    selectHandler,
    percentHandler,
    durationHandler,
    jsonHandler,
    principalHandler,
    resourceHandler,
  ].map((fieldType) => [fieldType.type, fieldType]),
);

export const LINK_FIELD_TYPES: Record<string, LinkFieldType> = {
  relation: relationHandler,
};

export const SERVER_GENERATED_FIELD_TYPES: Record<string, ServerGeneratedFieldKind> = {
  id: idHandler,
};

export const COMPUTED_FIELD_TYPES: Record<string, ComputedFieldKind> = Object.fromEntries(
  [formulaHandler, lookupHandler, rollupHandler, htmlTemplateHandler].map((fieldType) => [fieldType.type, fieldType]),
);

export const SYSTEM_FIELD_TYPES: Record<string, SystemFieldKind> = Object.fromEntries(
  [createdAtHandler, createdByHandler, updatedAtHandler, updatedByHandler].map((fieldType) => [fieldType.type, fieldType]),
);

export const EXTERNAL_FIELD_TYPES: Record<string, ExternalFieldKind> = {
  file: fileHandler,
};

export const RECORD_WRITABLE_FIELD_TYPES: Record<string, RecordWritableFieldType> = {
  ...VALUE_FIELD_TYPES,
  ...LINK_FIELD_TYPES,
};

export const fieldTypeRegistry: Record<string, FieldTypeDefinition> = {
  ...VALUE_FIELD_TYPES,
  ...LINK_FIELD_TYPES,
  ...SERVER_GENERATED_FIELD_TYPES,
  ...COMPUTED_FIELD_TYPES,
  ...SYSTEM_FIELD_TYPES,
  ...EXTERNAL_FIELD_TYPES,
};

export const getFieldType = (type: string): FieldTypeDefinition | null => fieldTypeRegistry[type] ?? null;

export const getRecordWritableFieldType = (type: string): RecordWritableFieldType | null => RECORD_WRITABLE_FIELD_TYPES[type] ?? null;

export const isKnownFieldType = (type: string): boolean => type in fieldTypeRegistry;

export const isRecordWritableFieldType = (type: string): boolean => type in RECORD_WRITABLE_FIELD_TYPES;

export const recordWritableFieldTypes = (): string[] => Object.keys(RECORD_WRITABLE_FIELD_TYPES);
