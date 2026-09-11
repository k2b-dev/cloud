import type { DateContext } from "@k2b/stdlib";
import { compileFormulaAstToSql } from "./formula-sql-expression-compiler";
import type { FormulaSqlCompileResult } from "./formula-sql-values";
import { compileObjectListValue } from "./object-list-sql";
import type { Field } from "./types";

/** One JSON projection for GQL and numeric list reductions; finalized records use stored cells. */
export const compileObjectListProjection = (
  field: Pick<Field, "id" | "config">,
  recordAlias: string,
  options: { now?: Date; dateConfig?: DateContext } = {},
): FormulaSqlCompileResult =>
  compileObjectListValue(field, recordAlias, (ast, resolveField, rowAlias) =>
    compileFormulaAstToSql(ast, { fields: [], recordAlias: rowAlias, resolveField, ...options }),
  );
