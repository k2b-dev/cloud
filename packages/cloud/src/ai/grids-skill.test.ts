import { expect, test } from "bun:test";
import { parseGridsQueryDsl } from "../../../grids/src/query-dsl/parser";
import { CLOUD_GRIDS_INSTRUCTIONS, CLOUD_GRIDS_QUERY_REFERENCE } from "./grids-skill";

test("Grids Skill examples use valid GQL rather than SQL or GraphQL", () => {
  const examples = [...`${CLOUD_GRIDS_INSTRUCTIONS}\n${CLOUD_GRIDS_QUERY_REFERENCE}`.matchAll(/```gql\n([\s\S]*?)```/g)];
  expect(examples.length).toBe(5);
  for (const [, query] of examples) expect(parseGridsQueryDsl(query!).ok).toBe(true);
});

test("Grids Skill separates query results, context and turn-local reference loading", () => {
  expect(CLOUD_GRIDS_INSTRUCTIONS.length).toBeLessThanOrEqual(10_000);
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("execute it before reporting");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("do not duplicate it as a Markdown table");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("load_skill again before reading a reference in a later turn");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("Custom App @auth/@time context is not injected here");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("'days'");
});
