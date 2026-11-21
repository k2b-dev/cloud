import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as capabilityActor from "@k2b/cloud/ai";
import { type AiRuntimeTool, aiConversations } from "@k2b/cloud/ai";
import { UserSchema } from "@k2b/cloud/contracts";
import { auth } from "@k2b/cloud/server";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { createCodeAuthoringRoutes } from "../api/code-authoring";
import type { CodeContext } from "./access";
import { createCodeAuthoringChatTools } from "./chat-tools";
import { codeAuthor, createCode, createCodeVersion } from "./store";

useUnitClients();
afterEach(() => mock.restore());
const id = "11111111-1111-4111-8111-111111111111";
const user = UserSchema.parse({
  id,
  uid: "guest",
  provider: "local",
  profile: "guest",
  roles: ["guest"],
  displayName: "Guest",
  givenname: "Guest",
  sn: "Fixture",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = {
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
  locale: "en",
} satisfies CodeContext;
const message = "Guests cannot create Code or submit versions. Please ask a Cloud member to help.";
const failure = { version: 1, error: { code: "code_guests_cannot_author", message, details: null } };

test("the store refuses guest creation and version writes before any persistence", async () => {
  await expect(createCode({ title: "Guest Code", owner: { kind: "person", userId: id } }, context)).rejects.toMatchObject({
    code: failure.error.code,
    message,
  });
  await expect(
    createCodeVersion(
      { codeId: "c_guest", sourceFiles: { "code.ts": "source" }, bundle: "bundle", manifest: null, baseVersionId: null },
      context,
    ),
  ).rejects.toMatchObject({ code: failure.error.code });
});

test.each([
  ["init", "en"],
  ["init", "de"],
  ["submit", "en"],
  ["submit", "de"],
])("HTTP %s returns the shared guest refusal in %s", async (command, locale) => {
  spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  spyOn(auth, "requireOAuthScope").mockReturnValue(async (_c, next) => next());
  spyOn(auth, "getAuthority").mockReturnValue(context.authority);
  const response = await createCodeAuthoringRoutes().request(`/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-locale": locale },
    body: JSON.stringify(
      command === "init" ? { title: "Guest Code" } : { codeId: "c_guest", files: { "code.ts": "source" }, baseVersionId: null },
    ),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    ...failure,
    error: {
      ...failure.error,
      message:
        locale === "de" ? "Gäste können keinen Code erstellen oder Versionen einreichen. Bitte wende dich an ein Cloud-Mitglied." : message,
    },
  });
});

test.each([
  ["code_init", { title: "Guest Code" }],
  ["code_submit", { codeId: "c_guest", files: { "code.ts": "source" }, baseVersionId: null }],
  ["code_write", { codeId: "c_guest", path: "code.ts", content: "changed" }],
  ["code_write", { codeId: "c_guest", path: "code.ts", delete: true }],
  ["code_write", { codeId: "c_guest", path: "code.ts", renameTo: "renamed.ts" }],
  ["code_check", { codeId: "c_guest" }],
  ["code_test", { codeId: "c_guest" }],
  ["code_submit", { codeId: "c_guest" }],
])("the %s tool refuses guest input %j before accessing Code or its draft", async (name, input) => {
  spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({ input: "Build Code", actor: context.authority.actor });
  spyOn(capabilityActor, "resolveAiCapabilityActor").mockResolvedValue(context.authority);
  const tools: AiRuntimeTool[] = createCodeAuthoringChatTools();
  const tool = tools.find((entry) => entry.def.name === name);
  if (!tool || !("location" in tool) || tool.location !== "server") throw new Error("Missing server tool");
  const result = await tool.run(tool.def.inputSchema.parse(input), {
    actor: context.authority.actor,
    conversationId: id,
    turnId: id,
    callId: "guest-call",
    locale: "en",
    signal: new AbortController().signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("Guest authoring must not request a client tool");
    },
    requestApprovalFor: async () => false,
    requestRelayedApproval: async () => false,
  });
  expect(result).toEqual(failure);
});

test("author eligibility uses the profile, preserves member access and localizes German", async () => {
  const member = {
    ...context,
    authority: { ...context.authority, actor: { kind: "user" as const, user: { ...user, profile: "user" as const } } },
  };
  expect(codeAuthor(member).id).toBe(id);
  await expect(
    createCode({ title: "Guest Code", owner: { kind: "person", userId: id } }, { ...context, locale: "de" }),
  ).rejects.toMatchObject({
    code: "code_guests_cannot_author",
    message: "Gäste können keinen Code erstellen oder Versionen einreichen. Bitte wende dich an ein Cloud-Mitglied.",
  });
});
