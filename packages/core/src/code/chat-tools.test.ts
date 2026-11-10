import { expect, test } from "bun:test";
import type { AiRuntimeTool } from "@k2b/cloud/ai";
import { checkCode, generateCodeSdk } from "@k2b/cloud/code";
import type { RequestActor } from "@k2b/cloud/server";
import { z } from "zod";
import { codeCheckOutcome, isFeatCodeTool } from "../../../cloud/src/ai/chat/message-utils";
import { isFailedTool } from "../../../cloud/src/ai/chat/tool-groups";
import { aiBuiltinToolName } from "../../../cloud/src/ai/chat/tool-names";
import { codeAuthoringFailure } from "../api/code-authoring";
import { CodeDataError } from "./access";
import { CodeAuthoringErrorSchema, codeAuthoringContracts } from "./authoring-contracts";
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

const codeId = "c_1234";
const actor: RequestActor = {
  kind: "user",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "person",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Test",
    sn: "User",
    displayName: "Test User",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
};
const block = (name: string, result: unknown) =>
  ({ id: `tool-${name}`, kind: "tool", callId: name, name, args: { codeId }, status: "completed", result }) as const;

test("a lasting Code command that answered with its error reads as a failed step in the chat", async () => {
  const runtimeTools: AiRuntimeTool[] = tools;
  const write = runtimeTools.find((item) => item.def.name === "code_write");
  if (!write || !("location" in write) || write.location !== "server") throw new Error("Expected the server tool code_write");
  // Without an interactive turn Core refuses the command; the chat tool returns Core's error body, not a thrown error.
  const refused = await write.run(write.def.inputSchema.parse({ project, path: "code.ts", content: "changed" }), {
    actor,
    signal: new AbortController().signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("Authoring is server owned");
    },
  });
  expect(CodeAuthoringErrorSchema.parse(refused).error.code).toBe("FORBIDDEN");
  expect(isFailedTool(block("code_write", refused))).toBe(true);
  expect(isFailedTool(block("code_write", project))).toBe(false);
  for (const name of tools.map((tool) => tool.def.name))
    expect(isFailedTool(block(name, codeAuthoringFailure(new Error("unknown")).body))).toBe(true);
});

test("a Code check reads Core's check result: diagnostics say not passed, a clean check says passed", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  // The real checker's own failure result, produced before it would compile anything.
  const result = await checkCode(
    { files: { "code.ts": "export default null;" }, entry: "code.ts", sdk, aiOperations: [] },
    { isolate: "/missing", compiler: "/missing", worker: "/missing", bun: "/missing" },
    AbortSignal.abort(),
  );
  expect(result.ok).toBe(false);
  const failed = codeAuthoringContracts.check.data.parse({ version: 1, result, manifest: null, permissions: [] });
  expect(codeCheckOutcome("code_check", failed)).toEqual({ passed: false, errors: 1 });
  expect(isFailedTool(block("code_check", failed))).toBe(false);
  const refused = codeAuthoringFailure(new CodeDataError("BAD_INPUT", "Code request exceeds the checker budget.")).body;
  expect(codeCheckOutcome("code_check", refused)).toBeNull();
  expect(isFailedTool(block("code_check", refused))).toBe(true);
});

test("Code tests and simulations that did not pass read as failed steps", () => {
  const outcome = (ok: boolean) =>
    codeAuthoringContracts.test.data.parse({
      version: 1,
      mode: "test",
      ok,
      error: null,
      diagnostics: [],
      cases: [{ name: "Monday", file: "test/monday.json", ok, runs: [] }],
    });
  expect(isFailedTool(block("code_test", outcome(false)))).toBe(true);
  expect(isFailedTool(block("code_simulate", { ...outcome(false), mode: "simulate" }))).toBe(true);
  expect(isFailedTool(block("code_test", outcome(true)))).toBe(false);
});

test("every lasting Code chat tool is a feat/code step with a name in English and German", () => {
  for (const name of tools.map((tool) => tool.def.name)) {
    expect(isFeatCodeTool(name)).toBe(true);
    for (const locale of ["en", "de"]) expect(aiBuiltinToolName(name, locale)).toBeString();
  }
  expect(aiBuiltinToolName("code_test", "de")).toBe("Testet mit erfundenen Daten");
});
