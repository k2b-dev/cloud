import { expect, test } from "bun:test";
import { z } from "zod";
import { codeAuthoringContracts } from "./authoring-contracts";
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

test("draft writes accept one target and one edit in a provider object schema", () => {
  const base = { codeId: "c_1234", path: "code.ts" };
  for (const edit of [{ content: "" }, { delete: true }, { renameTo: "lib.ts" }])
    expect(schema("code_write").safeParse({ ...base, ...edit }).success).toBe(true);
  for (const input of [
    { ...base },
    { ...base, delete: false },
    { ...base, content: "", delete: true },
    { ...base, content: "", renameTo: "lib.ts" },
    { ...base, delete: true, renameTo: "lib.ts" },
    { ...base, content: "", project },
    { path: "code.ts", content: "" },
    { project, path: "code.ts", delete: true },
    { project, path: "code.ts", renameTo: "lib.ts" },
    { ...base, renameTo: "../escape.ts" },
  ])
    expect(schema("code_write").safeParse(input).success).toBe(false);
});

test("chat commands can consume the draft while shared HTTP/CLI contracts still require files", () => {
  for (const name of ["code_check", "code_test", "code_submit"]) {
    const parsed = schema(name).parse({ codeId: "c_1234" });
    expect(parsed).not.toHaveProperty("entry");
  }
  for (const command of ["check", "test", "submit", "simulate"] as const)
    expect(codeAuthoringContracts[command].input.safeParse({ codeId: "c_1234" }).success).toBe(false);
  const fixture = { version: 1, name: "Monday", now: 1793448000000, seed: 42, mocks: [], runs: [{ entrypoint: "monday" }] };
  expect(schema("code_simulate").safeParse({ codeId: "c_1234", fixture }).success).toBe(true);
  for (const name of ["code_check", "code_test", "code_submit", "code_simulate"])
    expect(
      schema(name).safeParse({
        codeId: "c_1234",
        files: project.files,
        entry: "other.ts",
        ...(name === "code_simulate" ? { fixture } : {}),
      }).success,
    ).toBe(true);
});

test("a passing chat check leaves the checked bundle on the server; its hash stays in the manifest", () => {
  const check = tools.find((tool) => tool.def.name === "code_check");
  if (!check) throw new Error("Missing tool code_check");
  const hash = "a".repeat(64);
  const manifest = {
    version: 1,
    permissions: [],
    ai: false,
    entrypoints: [{ kind: "schedule", entrypoint: "monday", cron: "0 8 * * 1", file: "code.ts", line: 1 }],
    hashes: { source: hash, sdk: hash, bundle: hash },
  };
  const result = { ok: true, diagnostics: [], manifest, permissions: [] };
  const answer = (value: object) => ({ version: 1, result: value, manifest: null, permissions: [] });
  expect(check.def.outputSchema.safeParse(answer(result)).success).toBe(true);
  expect(check.def.outputSchema.safeParse(answer({ ...result, bundle: "export {}" })).success).toBe(false);
});
