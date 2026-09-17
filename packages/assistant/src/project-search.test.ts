import { expect, test } from "bun:test";
import type { AiProject } from "@k2b/cloud/ai";
import { UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import { searchAssistantProjects } from "./search";
import { assistantProjectsSearchOptions } from "./frontend/assistant-search";
import { assistantCapabilities } from "./capabilities";

const project = (shortId: string, name: string, description = ""): AiProject => ({
  id: `internal-${shortId}`, shortId, name, description, icon: "ti ti-folders", instructions: "", defaultModelProfileId: null,
  permission: "read", revision: 1, createdAt: "", updatedAt: "",
});
const context = { accessSubject: { type: "user" as const, userId: "owner" }, locale: "de" };
const input = { query: "RECHNUNG banking", tags: ["assistant-project"], limit: 1 };

test("project search uses the authorized catalog, matches names and descriptions before limiting, and returns public links", async () => {
  const result = await searchAssistantProjects(input, context, {
    list: async (subject) => {
      expect(subject).toEqual(context.accessSubject);
      return [project("Other1", "Other"), project("Bank01", "Banking", "Rechnung zuordnen"), project("Bank02", "Banking", "Rechnung prüfen")];
    },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(UniversalSearchDataSchema.safeParse(result.data.data).success).toBe(true);
  expect(result.data.data).toHaveLength(1);
  expect(result.data.data[0]).toMatchObject({ ref: { type: "assistant.project", id: "Bank01" }, links: [{ rel: "open", href: "/app/assistant?project=Bank01" }] });
  expect(JSON.stringify(result)).not.toContain("internal-");
});

test("empty project queries browse accessible projects and unsupported scopes do not fall back", async () => {
  let reads = 0;
  const projects = { list: async () => { reads++; return [project("Bank01", "Banking")]; } };
  const result = await searchAssistantProjects({ ...input, query: "" }, context, projects);
  expect(result.ok && result.data.data.length).toBe(1);
  expect(reads).toBe(1);
  expect((await searchAssistantProjects({ ...input, scope: { type: "assistant.chat", id: "Chat01" } }, context, projects)).ok).toBe(false);
  expect(reads).toBe(1);
  const empty = await searchAssistantProjects(input, context, { list: async () => [] });
  expect(empty.ok && empty.data.data).toEqual([]);
});

test("project popup opens global search with one typed context in the Assistant app", () => {
  const options = assistantProjectsSearchOptions("de");
  const tag = assistantCapabilities.queries["project.search"].universalSearch.tags[0].tag;
  expect(options).toEqual({ query: "", scope: { appId: "assistant", tag, label: "Projekte", icon: "ti ti-folders" } });
});
