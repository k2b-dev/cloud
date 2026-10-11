import { expect, test } from "bun:test";
import { AI_CLIENT_TOOL_ACTION_MAX_BYTES, aiClientToolOutputSchemas } from "./client-tool-results";
import { AI_LOCAL_TOOL_NAMES } from "./local-tool-contracts";

test("built-in client results use their declared schemas and exclude server tools", () => {
  expect([...aiClientToolOutputSchemas.keys()].sort()).toEqual(
    ["local_bash", ...AI_LOCAL_TOOL_NAMES, "survey", "text_editor", "code_open", "code_secret"].sort(),
  );
  const list = aiClientToolOutputSchemas.get("local_list");
  expect(list?.safeParse({ status: "completed", entries: "wrong" }).success).toBeFalse();
  expect(list?.safeParse({ status: "completed", path: "/work", entries: [], nextAfter: null }).success).toBeTrue();
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
