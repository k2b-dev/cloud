import { expect, test } from "bun:test";
import { parseGridsQueryDsl } from "../../../grids/src/query-dsl/parser";
import { CLOUD_GRIDS_INSTRUCTIONS, CLOUD_GRIDS_QUERY_REFERENCE } from "./grids-skill";

test("Grids Skill examples use valid GQL rather than SQL or GraphQL", () => {
  const examples = [...`${CLOUD_GRIDS_INSTRUCTIONS}\n${CLOUD_GRIDS_QUERY_REFERENCE}`.matchAll(/```gql\n([\s\S]*?)```/g)];
  expect(examples.length).toBe(6);
  for (const [, query] of examples) expect(parseGridsQueryDsl(query!).ok).toBe(true);
});

test("Grids Skill explains typed values without expanding query-chat authority", () => {
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("read grids-workflows before proposing query captures");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("generateDocument.data/output");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("generating a file does not execute a payment or import bookings");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("same idempotency key and unchanged input");
  expect(CLOUD_GRIDS_INSTRUCTIONS).not.toContain("is not retry-safe");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("Updating a list replaces the whole list");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("Omit calculated columns");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("not recursively finalized");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("not proof that its source record was finalized");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("grids-custom-app-api");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("They cannot change records");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("grids.workflow.run.read");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("accepted, not completed");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("never manufacture approval");
});

test("Grids Skill separates query results, context and turn-local reference loading", () => {
  expect(CLOUD_GRIDS_INSTRUCTIONS.length).toBeLessThanOrEqual(10_000);
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("execute it before reporting");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("Do not repeat its rows as a Markdown table");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("showTableToUser defaults to false");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("load_skill again before reading a reference in a later turn");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("Custom App @auth/@time context is not injected here");
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("'days'");
});
