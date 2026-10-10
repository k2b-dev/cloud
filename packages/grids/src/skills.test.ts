import { expect, test } from "bun:test";
import { parseGridsQueryDsl } from "./query-dsl/parser";
import { SKILLS } from "./skills";

const CLOUD_GRIDS_INSTRUCTIONS = SKILLS[0]!.instructions;
const CLOUD_GRIDS_QUERY_REFERENCE = SKILLS[0]!.references[0]!.content;

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-grids"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});
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

test("Grids Skill distinguishes file bytes from inspected contents", () => {
  expect(CLOUD_GRIDS_INSTRUCTIONS).toContain("grids.document.content.read");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("capabilities.streams.read");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("does not extract PDF text");
  expect(CLOUD_GRIDS_QUERY_REFERENCE).toContain("50 MiB");
});

test("Grids skill names canonical Help and declared capabilities", async () => {
  const grids = SKILLS[0]!;
  expect(grids.instructions).toContain("Help is the product handbook");
  expect(grids.instructions).toContain("search_help");
  expect(grids.instructions).toContain("read_help");
  expect(grids.instructions).toContain("For product questions");
  expect(grids.instructions).toContain("cannot change records");
  expect(grids.instructions).toContain("Clarify vague goals before discovery");
  expect(grids.instructions).toContain("preserving the requested entities");
  expect(grids.instructions).toContain("includeWriteContext true");
  expect(grids.instructions).toContain("TODAY()");
  const sources = await Promise.all(["capabilities.ts"].map((path) => Bun.file(new URL(`./${path}`, import.meta.url)).text()));
  const declared = new Set(sources.flatMap((source) => [...source.matchAll(/"([a-z0-9.-]+)": \{/g)].map((match) => `grids.${match[1]}`)));
  for (const match of grids.instructions.matchAll(/`(grids\.[a-z0-9.-]+)`/g)) expect(declared.has(match[1]!)).toBeTrue();
  const help = await Bun.file(new URL("./help/documents/en/grids-gql.help.md", import.meta.url)).text();
  expect(help).toContain("Query with AI");
});
