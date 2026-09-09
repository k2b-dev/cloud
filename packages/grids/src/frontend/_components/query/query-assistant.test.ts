import { expect, test } from "bun:test";
import { GRIDS_QUERY_TOOLS, queryAssistantInput } from "./query-assistant";

test("launch preserves source and exact query in an unsent draft without records", () => {
  const input = queryAssistantInput({
    baseId: "Base01",
    baseName: "Equipment",
    query: "from table {Table1}\nsearch 'a & b'",
    currentSource: { kind: "view", viewId: "View01", label: "Available equipment" },
    title: "Query with AI",
    prompt: "Help me query",
  });
  expect(input.launchedByAppId).toBe("grids");
  expect(input.draft?.content).toContainEqual({ type: "text", text: "from table {Table1}\nsearch 'a & b'" });
  expect(input.draft?.content).toContainEqual({
    type: "resource",
    ref: { type: "grids.base", id: "Base01" },
    title: "Equipment",
    icon: "ti ti-table",
    href: "/app/grids/Base01",
  });
  expect(input.draft?.content).toContainEqual({
    type: "resource",
    ref: { type: "grids.view", id: "View01" },
    title: "Available equipment",
    icon: "ti ti-eye",
  });
  expect(input.draft?.content.filter((part) => part.type === "text")).toHaveLength(2);
  expect(input.skills).toEqual(["cloud-grids"]);
  expect(input.allowedTools).toEqual(GRIDS_QUERY_TOOLS);
  expect(input.allowedTools?.filter((name) => /create|update|delete|write|bash|message/.test(name))).toEqual(["grids.view.create"]);
  for (const tool of input.preloadTools ?? [])
    expect(input.allowedTools).toContain("name" in tool ? tool.name : `${tool.appId}.${tool.id}`);
});
