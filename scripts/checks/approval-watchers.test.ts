import { expect, test } from "bun:test";
import { checkSource } from "./approval-watchers";

test("approval notices share the open-tab rule", () => {
  const shared = "if (!(await aiApprovalUnwatched(id))) return;";
  expect(checkSource("wake.ts", shared, true)).toEqual([]);
  expect(checkSource("wake.ts", "const ok = true;", true)).toHaveLength(1);
  expect(checkSource("other.ts", "const ok = true;", false)).toEqual([]);
  const copy = "sql`SELECT 1 WHERE t.run_config->>'signedInSession' IS NULL`";
  expect(checkSource("notify.ts", `${shared}\n${copy}`, true)).toMatchObject([{ line: 2 }]);
  expect(checkSource("notify.test.ts", copy, false)).toEqual([]);
});
