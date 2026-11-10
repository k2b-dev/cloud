import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiRuntimeTool } from "@k2b/cloud/ai";
import { checkCode, generateCodeSdk } from "@k2b/cloud/code";
import type { RequestActor } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { codeAuthoringFailure } from "../api/code-authoring";
import { CodeDataError } from "./access";
import { CodeAuthoringErrorSchema, codeAuthoringContracts } from "./authoring-contracts";
import { createCodeAuthoringChatTools } from "./chat-tools";

const root = mkdtempSync(join(tmpdir(), "core-code-chat-steps-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { AiTurnBlockView }] = await Promise.all([import("@k2b/ui"), import("@k2b/cloud/ai/ui")]);

// Core's real chat tools and result contracts, drawn by the chat's public step view.
const tools: AiRuntimeTool[] = createCodeAuthoringChatTools();
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
const project = {
  version: 1,
  config: {
    version: 1,
    codeId: "c_1234",
    title: "Fictional Code",
    owner: { kind: "person", userId: actor.kind === "user" ? actor.user.id : "" },
    entry: "code.ts",
    baseVersionId: null,
  },
  files: { "code.ts": "export default null;" },
};
/** One finished step row as the chat draws it, in the reader's language. */
const step = (name: string, result: unknown, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiTurnBlockView, {
          block: { id: `tool-${name}`, kind: "tool", callId: name, name, args: { codeId: "c_1234" }, status: "completed", result },
          turnId: "turn-1",
        });
      },
    }),
  );
const label = (html: string) => /<strong>([^<]*)<\/strong>/.exec(html)?.[1] ?? "";
const failed = (html: string) => html.includes('data-tone="danger"');

test("a lasting Code command that answered with Core's error shows as a failed step", async () => {
  const write = tools.find((item) => item.def.name === "code_write");
  if (!write || !("location" in write) || write.location !== "server") throw new Error("Expected the server tool code_write");
  // Without an interactive turn Core refuses; the chat tool returns Core's error body instead of throwing.
  const refused = await write.run(write.def.inputSchema.parse({ project, path: "code.ts", content: "changed" }), {
    actor,
    signal: new AbortController().signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("Authoring is server owned");
    },
  });
  expect(CodeAuthoringErrorSchema.parse(refused).error.code).toBe("FORBIDDEN");
  expect(failed(step("code_write", refused))).toBe(true);
  expect(label(step("code_write", refused, "de"))).toContain("Bearbeitet eine Code-Datei");
  expect(failed(step("code_write", project))).toBe(false);
  const failure = codeAuthoringFailure(new Error("unknown")).body;
  for (const name of tools.map((tool) => tool.def.name)) expect(failed(step(name, failure))).toBe(true);
});

test("a Code check with diagnostics is a finished check; a check Core refused is a failed step", async () => {
  // The real checker's own failure result, produced before it would compile anything.
  const result = await checkCode(
    { files: { "code.ts": "export default null;" }, entry: "code.ts", sdk: generateCodeSdk([], { mode: "personal" }), aiOperations: [] },
    { isolate: "/missing", compiler: "/missing", worker: "/missing", bun: "/missing" },
    AbortSignal.abort(),
  );
  expect(result.ok).toBe(false);
  const checked = codeAuthoringContracts.check.data.parse({ version: 1, result, manifest: null, permissions: [] });
  // Its outcome, "1 finding", is the step row's; packages/cloud tests it with this same result shape.
  expect(failed(step("code_check", checked))).toBe(false);
  const refused = codeAuthoringFailure(new CodeDataError("BAD_INPUT", "Code request exceeds the checker budget.")).body;
  expect(failed(step("code_check", refused))).toBe(true);
});

test("Code tests and simulations that did not pass show as failed steps", () => {
  const outcome = (ok: boolean, mode: "test" | "simulate" = "test") =>
    codeAuthoringContracts.test.data.parse({
      version: 1,
      mode,
      ok,
      error: null,
      diagnostics: [],
      cases: [{ name: "Monday", file: mode === "test" ? "test/monday.json" : null, ok, runs: [] }],
    });
  expect(failed(step("code_test", outcome(false)))).toBe(true);
  expect(failed(step("code_simulate", outcome(false, "simulate")))).toBe(true);
  expect(failed(step("code_test", outcome(true)))).toBe(false);
});

test("every lasting Code chat tool has a step name that says what happens, in English and German", () => {
  for (const name of tools.map((tool) => tool.def.name))
    for (const locale of ["en", "de"]) {
      const text = label(step(name, {}, locale));
      expect(text.length).toBeGreaterThan(0);
      // Without a name the row would read the tool name in words, like "Code init".
      expect(text).not.toMatch(/^Code [a-z]+$/);
    }
  expect(label(step("code_test", {}, "de"))).toBe("Testet mit erfundenen Daten");
});
