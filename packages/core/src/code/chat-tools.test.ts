import { expect, test } from "bun:test";
import { z } from "zod";
import { createCodeAuthoringChatTools } from "./chat-tools";

const tools = createCodeAuthoringChatTools();
const schema = (name: string) => {
  const tool = tools.find((item) => item.def.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.def.inputSchema;
};
const project = {
  version: 1,
  config: {
    version: 1,
    codeId: "c_1234",
    title: "Fictional Code",
    owner: { kind: "person", userId: "11111111-1111-4111-8111-111111111111" },
    entry: "code.ts",
    baseVersionId: null,
  },
  files: { "code.ts": "export default null;" },
};

test("chat tool schemas are provider object schemas and expose no activation or access writes", () => {
  expect(tools.map((tool) => tool.def.name)).toEqual([
    "code_init",
    "code_pull",
    "code_sdk",
    "code_test",
    "code_simulate",
    "code_submit",
    "code_diff",
    "code_read",
    "code_write",
    "code_check",
  ]);
  for (const tool of tools) expect(z.toJSONSchema(tool.def.inputSchema).type).toBe("object");
});

test("stable read/write/check names accept lasting Code and reject Studio overloads", () => {
  for (const [name, input] of [
    ["code_read", { codeId: "c_1234" }],
    ["code_write", { project, path: "code.ts", content: "changed" }],
    ["code_check", { codeId: "c_1234", files: project.files }],
  ] as const)
    expect(schema(name).safeParse(input).success).toBe(true);
  for (const [name, input] of [
    ["code_read", { id: "Abc234", path: "index.html", offset: 0 }],
    ["code_write", { id: "Abc234", path: "index.html", content: "changed", expectedRevision: 1 }],
    ["code_check", { id: "Abc234" }],
    ["code_check", { files: [{ path: "index.html", content: "<h1>Fixture</h1>" }] }],
    ["code_read", { codeId: "c_1234", id: "Abc234" }],
    ["code_write", { project, path: "../escape.ts", content: "invalid" }],
  ] as const)
    expect(schema(name).safeParse(input).success).toBe(false);
});
