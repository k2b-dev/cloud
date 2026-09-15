import type { Scope } from "./resolver-scope";
import { createDslScopedFormulaFieldResolver } from "./scoped-formula";

export const scopedFormulaResolverForScope = (scope: Scope) =>
  createDslScopedFormulaFieldResolver({
    base: {
      ...(scope.sourceAlias ? { alias: scope.sourceAlias } : {}),
      fields: scope.fields,
      recordAlias: "r",
      computedFieldSql: scope.computedStub,
    },
    joins: [...scope.joins.values()].map((join) => ({
      alias: join.alias,
      fields: join.fields,
      recordAlias: join.alias,
      computedFieldSql: join.computedStub,
    })),
    summaries: [...scope.summaryJoins.values()].map((join) => ({ alias: join.alias, recordAlias: join.alias, columns: join.columns })),
  });
