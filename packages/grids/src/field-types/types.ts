import type { z } from "zod";
import type { FormulaRuntimeContext } from "../formula/function-runtime";

export type FieldValidationContext = FormulaRuntimeContext & { locale?: string };

type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): ValidateResult<T> => ({ ok: true, value });
export const fail = (error: string): ValidateResult<never> => ({ ok: false, error });

type FieldTypeBase = {
  type: string;
  /** Zod schema for the field's config blob (what's saved in fields.config). */
  configSchema: z.ZodTypeAny;
};

export type ValueFieldType = FieldTypeBase & {
  kind: "value";
  /**
   * Validate + normalize a raw API value to its canonical JSONB form.
   * `null` / `undefined` / empty strings collapse to `null` unless `required`.
   */
  validate(raw: unknown, config: unknown, required: boolean, context?: FieldValidationContext): ValidateResult<unknown>;
};

export type LinkFieldType = FieldTypeBase & {
  kind: "link";
  /** Validate a user-submitted link value. Storage is handled by record_links. */
  validate(raw: unknown, config: unknown, required: boolean): ValidateResult<unknown>;
};

export type ServerGeneratedFieldKind = FieldTypeBase & {
  kind: "serverGenerated";
};

export type ComputedFieldKind = FieldTypeBase & {
  kind: "computed";
};

export type SystemFieldKind = FieldTypeBase & {
  kind: "system";
};

export type ExternalFieldKind = FieldTypeBase & {
  kind: "external";
};

export type RecordWritableFieldType = ValueFieldType | LinkFieldType;

export type FieldTypeDefinition =
  | ValueFieldType
  | LinkFieldType
  | ServerGeneratedFieldKind
  | ComputedFieldKind
  | SystemFieldKind
  | ExternalFieldKind;
