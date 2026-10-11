import { expect, test } from "bun:test";
import { AI_CLIENT_TOOL_ACTION_MAX_BYTES, aiClientToolOutputSchemas } from "./client-tool-results";
import { AI_LOCAL_TOOL_NAMES, AiLocalContextSchema, CloudAiLocalListOutputSchema } from "./local-tool-contracts";

test("only local client results use their declared schemas", () => {
  expect([...aiClientToolOutputSchemas.keys()].sort()).toEqual(["local_bash", ...AI_LOCAL_TOOL_NAMES].sort());
  const list = aiClientToolOutputSchemas.get("local_list");
  expect(list?.safeParse({ status: "completed", entries: "wrong" }).success).toBeFalse();
  expect(list?.safeParse({ status: "completed", path: "/work", entries: [], nextAfter: null }).success).toBeTrue();
});

test("local_list preserves trailing spaces and whitespace-only file names", () => {
  const result = {
    status: "completed" as const,
    path: "/work",
    entries: ["Scan 12.pdf ", " "].map((path) => ({ path, type: "file" as const, size: 12, modifiedAt: "2026-10-11" })),
    nextAfter: "Scan 12.pdf ",
  };
  expect(CloudAiLocalListOutputSchema.parse(result)).toEqual(result);
});

test("local Skill context retains the optional manualOnly flag", () => {
  const skills = [
    { name: "invoice", description: "Invoice workflow.", scope: "project" as const, manualOnly: true },
    { name: "notes", description: "Meeting notes.", scope: "global" as const, manualOnly: false },
    { name: "mail", description: "Email workflow.", scope: "global" as const },
  ];
  expect(AiLocalContextSchema.parse({ skills }).skills).toEqual(skills);
});

test("action body limit accommodates two maximally escaped Bash streams and envelope", () => {
  const output = {
    type: "tool_result",
    result: {
      status: "completed",
      exitCode: 0,
      stdout: "\u0000".repeat(512 * 1024),
      stderr: "\u0000".repeat(512 * 1024),
      truncated: false,
    },
  };
  expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThan(AI_CLIENT_TOOL_ACTION_MAX_BYTES);
  expect(aiClientToolOutputSchemas.get("local_bash")?.safeParse(output.result).success).toBeTrue();
});
