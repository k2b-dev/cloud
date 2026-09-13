import { describe, expect, test } from "bun:test";
import { parseGridsQueryDsl } from "./parser";

const removedPublicSyntax = [
  { query: "skip 5", diagnostic: 'use "offset" instead of "skip"' },
  { query: "sort Amount ascending", diagnostic: 'use "asc" instead of "ascending"' },
  { query: "sort Amount descending", diagnostic: 'use "desc" instead of "descending"' },
  { query: "where Amount > 0 && Cost > 0", diagnostic: 'use "and" instead of "&&" in GQL predicates' },
  { query: "where Amount > 0 || Cost > 0", diagnostic: 'use "or" instead of "||" in GQL predicates' },
  { query: "where !Paid", diagnostic: 'use "not" instead of "!" in GQL predicates' },
  { query: "where AND(Status = 'Open', Amount > 0)", diagnostic: 'use "and" as an operator instead of "AND(...)" in GQL expressions' },
  { query: "where OR(Status = 'Open', Status = 'Closed')", diagnostic: 'use "or" as an operator instead of "OR(...)" in GQL expressions' },
  { query: "where NOT(Paid)", diagnostic: 'use "not" as an operator instead of "NOT(...)" in GQL expressions' },
  {
    query: "having formula(revenue > 0)",
    diagnostic: "where and having clauses already use formula syntax; write the expression directly without formula(...)",
  },
  { query: "from table #Orders", diagnostic: "invalid from source" },
  { query: "select #Amount", diagnostic: "invalid select item" },
  { query: "aggregate sum(#Amount) as revenue", diagnostic: "invalid aggregate argument" },
  { query: "search 'open' in #Status", diagnostic: "invalid search field" },
] as const;

describe("public GQL syntax golden contract", () => {
  test("removed public aliases fail with stable replacement diagnostics", () => {
    for (const item of removedPublicSyntax) {
      const result = parseGridsQueryDsl(item.query);

      expect(result.ok, item.query).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.message).toContain(item.diagnostic);
    }
  });
});
