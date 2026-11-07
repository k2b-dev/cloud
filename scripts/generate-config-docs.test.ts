import { expect, test } from "bun:test";
import { env } from "../packages/cloud/src/config/env";

test("generated workflow budget reference exposes its JSON type and concrete default", async () => {
  const docs = await Bun.file(new URL("../docs-site/docs/en/operations/configuration.md", import.meta.url)).text();
  const row = docs.split("\n").find((line) => line.startsWith("| `WORKFLOW_AI_BUDGET` |"));
  expect(row).toContain("| JSON |");
  expect(row).toContain(JSON.stringify(env.$specs.WORKFLOW_AI_BUDGET.default));
  expect(row).not.toContain("[object Object]");
});
