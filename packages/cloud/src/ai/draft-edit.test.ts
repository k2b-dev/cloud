import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import * as registry from "../_internal/registry";
import { presentReview } from "../capabilities/legacy-review-view";
import { restoreReviewSnapshot } from "../capabilities/review-storage";
import * as capabilities from "../capabilities/server";
import type { RequestAuthority } from "../server/middleware/auth";
import { approvalArgsDigest, approvalReviewDigest, approvals } from "../services/approvals";
import { userResourceContext } from "./projects.test-fixture";
import { defineAiTool, prepareAiTools } from "./tools";

const authority: RequestAuthority = {
  ...userResourceContext({ type: "user", userId: "11111111-1111-4111-8111-111111111111" }),
  credentialKind: "session",
  scopes: [],
};
const raw = () => ({
  ...reviewFixture(),
  view: {
    version: 1 as const,
    blocks: [
      {
        kind: "Draft" as const,
        context: [{ label: "From", value: "test@example.com" }],
        fields: [
          { name: "subject", label: "Subject", type: "text" as const, value: "Original" },
          { name: "body", label: "Body", type: "textarea" as const, value: "Original body" },
        ],
      },
    ],
  },
});
let state = {
  details: raw(),
  pending_review: {} as unknown,
  review_digest: "",
  args: { subject: "Original", body: "Original body" } as unknown,
  kind: "action",
  status: "pending",
  argsDigest: "",
};
let queries = 0;
const query = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
  queries++;
  if (typeof strings === "string") return [];
  const text = strings.join("?");
  if (text.includes("auth_epoch::text")) return [{ epoch: "1" }];
  if (text.includes("SELECT kind, author_user_id")) return [{ kind: state.kind, authorUserId: null, status: state.status }];
  if (text.includes("FROM approvals.requests") && text.includes("FOR UPDATE") && !text.includes(" JOIN "))
    return [{ kind: state.kind, status: state.status, details: state.details, reviewDigest: state.review_digest, assurance: "confirm" }];
  if (text.includes("FROM approvals.requests r JOIN"))
    return state.kind === "action" && state.status === "pending"
      ? [
          {
            ...state,
            id: "22222222-2222-4222-8222-222222222222",
            app_id: "demo",
            action: "send",
            call_id: "send-approval-0",
            turn_id: "33333333-3333-4333-8333-333333333333",
            conversation_id: "44444444-4444-4444-8444-444444444444",
            run_config: { kind: "chat", actor: authority.actor },
          },
        ]
      : [];
  if (text.includes("UPDATE approvals.requests")) {
    const digest = values.at(-1);
    if (digest !== state.review_digest) return [];
    state.details = restoreReviewSnapshot(JSON.parse(String(values[0]))) as ReturnType<typeof raw>;
    state.argsDigest = String(values[1]);
    state.review_digest = String(values[2]);
    return [{ id: "updated" }];
  }
  if (text.includes("UPDATE ai.pending_actions")) {
    state.args = JSON.parse(String(values[0]));
    state.pending_review = JSON.parse(String(values[1]));
    return [];
  }
  if (text.includes("SELECT p.args,p.review")) return [{ args: state.args, review: state.pending_review }];
  return [];
};
const fakeSql = Object.assign(query, { begin: async (fn: (tx: typeof query) => Promise<unknown>) => fn(query) });
mock.module("../runtime/clients", () => ({ sql: fakeSql }));
const { draftEditValues, editAiApprovalDraft, editedDraftArguments } = await import("./draft-edit");
afterEach(() => mock.restore());
function setup() {
  const compiled = compileCapabilities("demo", {
    protocolVersion: 2,
    actions: {
      send: {
        title: "Send",
        description: "Send",
        input: z.strictObject({ subject: z.string().max(998).describe("Subject"), body: z.string().max(65536).describe("Body") }),
        data: z.object({}),
        idempotency: "required",
        openWorld: true,
        destructive: true,
        policy: { ask: "sends" },
        review: () => ({ ok: true, data: raw() }),
        run: () => ({ ok: true, data: { data: {} } }),
      },
    },
  });
  spyOn(registry, "getCapability").mockResolvedValue({ appId: "demo", manifest: compiled.manifest } as Awaited<
    ReturnType<typeof registry.getCapability>
  >);
  spyOn(capabilities, "reviewCapabilityAction").mockImplementation(async (invocation) => {
    const input = z.object({ subject: z.string(), body: z.string() }).parse(invocation.input);
    const review = raw();
    review.view.blocks[0]!.fields[0]!.value = input.subject;
    review.view.blocks[0]!.fields[1]!.value = input.body;
    return { ok: true, data: review };
  });
  state = {
    details: raw(),
    pending_review: {},
    review_digest: approvalReviewDigest(raw()),
    args: { subject: "Original", body: "Original body" },
    kind: "action",
    status: "pending",
    argsDigest: "",
  };
  queries = 0;
}
const edit = (values: Record<string, string>, digest = state.review_digest) =>
  editAiApprovalDraft({ id: "22222222-2222-4222-8222-222222222222", values, digest, authority, signedInSession: true });
test("only declared Draft strings are accepted; legacy conversions never grant editability", () => {
  expect(() => draftEditValues(raw(), { to: "Someone else" })).toThrow("declared string fields");
  expect(() => draftEditValues(raw(), { body: 12 as never })).toThrow("declared string fields");
  const { view: _view, ...old } = reviewFixture();
  expect(() =>
    draftEditValues({ ...old, preview: { kind: "page", title: "Old", body: "Text", format: "plain" } }, { body: "Edit" }),
  ).toThrow("no editable draft");
  expect(() => draftEditValues({ ...raw(), view: undefined }, { body: "Edit" })).toThrow("no editable draft");
  expect(() =>
    draftEditValues(presentReview({ ...old, preview: { kind: "page", title: "Old", body: "Text", format: "plain" } }), { body: "Edit" }),
  ).toThrow("no editable draft");
});
test("non-browser authority is refused before any database operation", async () => {
  queries = 0;
  await expect(
    editAiApprovalDraft({ id: "unused", values: { body: "Edit" }, digest: "a".repeat(64), authority, signedInSession: false }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    editAiApprovalDraft({
      id: "unused",
      values: { body: "Edit" },
      digest: "a".repeat(64),
      authority: { ...authority, credentialKind: "api_key" },
      signedInSession: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(queries).toBe(0);
});
test("code_version and stale requests cannot be edited; extra keys are rejected", async () => {
  setup();
  state.kind = "code_version";
  await expect(edit({ body: "Edit" })).rejects.toMatchObject({ status: 404 });
  state.kind = "action";
  await expect(edit({ body: "Edit" }, "b".repeat(64))).rejects.toMatchObject({ status: 409 });
  await expect(edit({ recipients: "other" })).rejects.toMatchObject({ status: 400 });
  expect(state.args).toEqual({ subject: "Original", body: "Original body" });
});
test("re-review CAS stores effective arguments and replay sends edits while retaining original model arguments", async () => {
  setup();
  const old = state.review_digest;
  const result = await edit({ subject: "Edited", body: "Edited body" });
  expect(result.digest).not.toBe(old);
  expect(state.argsDigest).toBe(approvalArgsDigest({ subject: "Edited", body: "Edited body" }));
  await expect(edit({ body: "Stale" }, old)).rejects.toMatchObject({ status: 409 });
  await expect(
    approvals.decide(
      "22222222-2222-4222-8222-222222222222",
      { approved: true },
      { userId: "11111111-1111-4111-8111-111111111111", via: "web_session" },
    ),
  ).resolves.toMatchObject({ ok: false, code: "REVIEW_CHANGED" });
  await expect(
    approvals.decide(
      "22222222-2222-4222-8222-222222222222",
      { approved: true, digest: old },
      { userId: "11111111-1111-4111-8111-111111111111", via: "web_session" },
    ),
  ).resolves.toMatchObject({ ok: false, code: "REVIEW_CHANGED" });
  const original = { subject: "Original", body: "Original body" };
  const seen: unknown[] = [];
  const tool = defineAiTool({
    name: "demo.send",
    description: "Send",
    inputSchema: z.object({ subject: z.string(), body: z.string() }),
    outputSchema: z.unknown(),
    approval: "never",
  }).server(async (args) => {
    seen.push(args);
    return { ok: true, data: { sent: args } };
  });
  const prepared = prepareAiTools({
    actor: authority.actor,
    tools: [tool],
    effectiveArguments: (callId, name, args) =>
      editedDraftArguments({
        conversationId: "44444444-4444-4444-8444-444444444444",
        turnId: "33333333-3333-4333-8333-333333333333",
        callId,
        name,
        args,
      }),
  });
  const runtime = prepared.tools[0]!;
  if (runtime.kind !== "server") throw new Error("Expected server tool");
  const output = await runtime.execute(original, {
    callId: "send",
    signal: new AbortController().signal,
    requestApproval: async () => true,
    requestClientTool: async () => {
      throw new Error("unused");
    },
  });
  expect(seen).toEqual([{ subject: "Edited", body: "Edited body" }]);
  expect(original).toEqual({ subject: "Original", body: "Original body" });
  expect(output).toMatchObject({ cloudNote: expect.stringContaining("subject, body") });
  await edit({ body: "Second edit" });
  expect(
    (
      await editedDraftArguments({
        conversationId: "44444444-4444-4444-8444-444444444444",
        turnId: "33333333-3333-4333-8333-333333333333",
        callId: "send",
        name: "demo.send",
        args: original,
      })
    ).fields,
  ).toEqual(["subject", "body"]);
});
