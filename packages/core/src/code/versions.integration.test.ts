import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { CAPABILITY_MAX_RESULT_BYTES, CapabilityActionCallReviewSchema, CloudResourceReaderViewSchema } from "@k2b/cloud/contracts";
import { approvalArgsDigest, approvals, migrateApprovals } from "@k2b/cloud/services/approvals";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migratePwa } from "../migrate/core/pwa";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import type { Code, CodeSourceFiles } from "./contracts";
import type { CodePolicyRow } from "./policy-contracts";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { addCodeShare, codeBundleHash, codeSourceHash, createCode, findCode, readCode, readCodeVersion } from "./store";
import type { CodeCheckedVersionManifest, CodeVersionSubmission } from "./version-contracts";
import { codeVersionDiff } from "./version-diff";
import {
  decideCodeVersion,
  diffCodeVersion,
  listCodeVersions,
  readCodeVersionDiff,
  recordCodeVersionBaseline,
  requireCodeVersionApproval,
  reviewCodeExecutionChange,
  reviewCodeVersionDecision,
  reviewCodeVersionSubmission,
  setCodePaused,
  startCodeVersionApprovals,
  submitCodeVersion,
} from "./versions";

const operation = {
  title: "Fixture",
  description: "Fixture operation.",
  openWorld: false,
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  run: () => ({ ok: true as const, data: { data: {} } }),
};
const action = {
  ...operation,
  review: () => ({
    ok: true as const,
    data: {
      locale: "en",
      slots: {},
      sentence: { action: "Change fixture", running: "Changing fixture", done: "Changed fixture", confirm: "Confirm", decline: "Cancel" },
    },
  }),
};
const catalog = compileCapabilityManifest("example", {
  protocolVersion: 2,
  types: { item: { title: "Fixture item", description: "Fixture owner.", reader: "item.read" } },
  queries: {
    "item.read": {
      ...operation,
      input: z.object({ id: z.string().describe("Fixture item ID.") }).strict(),
      data: z.object({ view: CloudResourceReaderViewSchema }).strict(),
      run: () => ({ ok: true as const, data: { data: { view: { title: "Fixture item", permission: "admin" as const } } } }),
    },
  },
  actions: {
    "item.change": { ...action, destructive: false, idempotency: "none", policy: { silent: "shared" } },
    "item.person_only": { ...action, destructive: false, idempotency: "none", code: false, policy: { silent: "shared" } },
    "item.delete": { ...action, destructive: true, idempotency: "required", policy: { ask: "deletes" } },
    "item.send": { ...action, destructive: false, idempotency: "required", policy: { ask: "sends" } },
  },
});
const fixed = new Date("2026-10-31T12:00:00.000Z");
const authorId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const strangerId = "33333333-3333-4333-8333-333333333333";
const machineId = "44444444-4444-4444-8444-444444444444";
const person = (id: string): User => ({
  id,
  uid: id,
  roles: id === strangerId ? ["user"] : ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
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
const context = (id = authorId): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
  locale: "de",
});
const author = context(),
  reviewer = context(reviewerId);
const input = (code: Code, source: string, baseVersionId: string | null = null, rows: CodePolicyRow[] = ["silent_shared"]) => {
  const sourceFiles: CodeSourceFiles = { "code.ts": source, "same.ts": "export const unchanged = true;\n" };
  const bundle = `bundle:${source}`;
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.ts",
    hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
    entrypoints: [{ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1", file: "code.ts", line: 1 }],
    ai: rows.includes("ai"),
    policyRows: rows,
    permissions: rows
      .filter((row) => row !== "ai" && row !== "internet")
      .map((row) => ({
        operation: row === "read" ? "example.item.read" : "example.item.change",
        target: { type: "example.item", id: "item" },
        file: "code.ts",
        line: 1,
      })),
  };
  return { codeId: code.id, sourceFiles, bundle, manifest, baseVersionId };
};

let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
databaseSuite()("C8 immutable versions, comparisons and platform decisions", () => {
  let dispose: (() => void) | undefined;
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let catalogSpy: ReturnType<typeof spyOn<typeof provider, "getCapabilityCatalogApp">>;
  let ordinal = 0;
  async function newCode(): Promise<Code> {
    const id = `c_c8${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,created_at) VALUES(${id},'person',${authorId}::uuid,'Weekly report',${authorId}::uuid,${fixed})`;
    return (await readCode(id, author)).code;
  }
  async function activate(code: Code, version: CodeVersionSubmission, recordBaseline = true) {
    await sql.begin(async (tx) => {
      await tx`SELECT singleton FROM code.policy FOR SHARE`;
      await tx`SELECT id FROM code.codes WHERE id=${code.id} FOR UPDATE`;
      await requireCodeVersionApproval(code, version.version.id, tx);
      await tx`UPDATE code.codes SET active_version_id=${version.version.id}::uuid,state='active' WHERE id=${code.id}`;
      if (recordBaseline) await recordCodeVersionBaseline(code.id, version.version.id, tx);
    });
  }
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_versions");
    await migrateAuth();
    await migratePwa();
    await migrateAppApproval();
    await migrateSettings();
    await migrateAudit();
    await migrateCode();
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    for (const id of [authorId, reviewerId, strangerId])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${id},'local','user',${id !== strangerId})`;
    await sql`INSERT INTO auth.service_accounts(id,name,kind,created_by) VALUES(${machineId}::uuid,'admin-machine','standalone',${authorId}::uuid)`;
    await sql`INSERT INTO auth.service_account_credentials(service_account_id,name,token_prefix,secret_hash,scopes)
      VALUES(${machineId}::uuid,'admin-token','c8-admin-machine','unused',ARRAY['admin'])`;
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    catalogSpy = spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: {
        appId: "example",
        appName: "Example",
        appIcon: "ti ti-code",
        appDescription: "Fixture",
        manifest: catalog,
      },
    });
    dispose = startCodeVersionApprovals();
  });
  beforeEach(async () => {
    await sql`UPDATE auth.users SET admin=(id<>${strangerId}::uuid),account_expires=NULL,auth_epoch=0`;
    await sql`UPDATE code.policy_rules SET value=CASE WHEN row IN ('read','silent_you','silent_draft') THEN 'automatic' ELSE 'admin' END WHERE group_id IS NULL`;
  });
  afterAll(async () => {
    dispose?.();
    settingsSpy?.mockRestore();
    catalogSpy?.mockRestore();
    setSystemTime();
  });

  test("the Code pause Action forwards its target ID to the owning service", async () => {
    const code = await newCode(),
      other = await newCode();
    await activate(code, await submitCodeVersion(input(code, "first", null, ["read"]), author));
    await activate(other, await submitCodeVersion(input(other, "other", null, ["read"]), author));
    const caller: CapabilityExecutionContext = {
      authority: author.authority,
      actor: author.authority.actor,
      accessSubject: author.authority.accessSubject,
      user: person(authorId),
      locale: "de",
      origin: "app",
      requestId: "code-target-seam",
      signal: new AbortController().signal,
      target: { type: "core.code", id: code.id },
    };
    expect(await aiCapabilities.actions["code.pause"].run({}, caller)).toMatchObject({
      ok: true,
      data: { data: { state: "paused" } },
    });
    expect(await findCode(code.id)).toMatchObject({ state: "paused" });
    expect(await findCode(other.id)).toMatchObject({ state: "active" });
    expect(await aiCapabilities.actions["code.pause"].run({}, { ...caller, target: undefined })).toMatchObject({ ok: false });
    expect(await findCode(other.id)).toMatchObject({ state: "active" });
  });
  test("forward migration is additive and idempotent over filled version evidence", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "one"), author);
    const before = await sql`SELECT * FROM code.version_submissions WHERE version_id=${submission.version.id}::uuid`;
    await migrateVersions();
    await migrateVersions();
    expect(await sql`SELECT * FROM code.version_submissions WHERE version_id=${submission.version.id}::uuid`).toEqual(before);
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${machineId}::uuid`).toHaveLength(1);
  });
  test("submission, execution and decision reviews identify exact targets without mutating state", async () => {
    const code = await newCode();
    await sql`UPDATE code.codes SET title=${"🧑‍💻 Weekly\nreport\u00ad"} WHERE id=${code.id}`;
    const reviewTitle = "🧑 💻 Weekly report";
    const draft = input(code, "review source", null, ["read"]);
    for (const locale of ["en", "de"]) {
      const ctx = { ...author, locale };
      const review = await reviewCodeVersionSubmission(draft, ctx);
      expect(CapabilityActionCallReviewSchema.safeParse(review).success).toBe(true);
      expect(review.slots.code).toEqual({ kind: "object", title: reviewTitle });
      expect(review).toEqual(await reviewCodeVersionSubmission(draft, ctx));
      expect(review.content?.kind).toBe("page");
      if (review.content?.kind === "page")
        expect(JSON.parse(review.content.body)).toMatchObject({ codeId: code.id, manifest: draft.manifest, bundle: draft.bundle });
    }
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
    const submitted = await submitCodeVersion(draft, author);
    await activate(code, submitted);
    const active = await findCode(code.id);
    for (const locale of ["en", "de"]) {
      for (const paused of [true, false]) {
        const ctx = { ...author, locale };
        const review = await reviewCodeExecutionChange(code.id, paused, ctx);
        expect(CapabilityActionCallReviewSchema.safeParse(review).success).toBe(true);
        expect(review.slots.code).toEqual({ kind: "object", title: reviewTitle });
        expect(review).toEqual(await reviewCodeExecutionChange(code.id, paused, ctx));
        expect(review.content?.kind).toBe("page");
        if (review.content?.kind === "page")
          expect(JSON.parse(review.content.body)).toMatchObject({
            activeVersionId: submitted.version.id,
            after: paused ? "paused" : "active",
          });
      }
    }
    expect(await findCode(code.id)).toEqual(active);
    const pending = await submitCodeVersion(input(code, "second", submitted.version.id), author);
    for (const approved of [true, false]) {
      const review = await reviewCodeVersionDecision(pending.binding, approved, reviewer);
      expect(CapabilityActionCallReviewSchema.safeParse(review).success).toBe(true);
      expect(review.slots.code).toEqual({ kind: "object", title: reviewTitle });
      expect(review.slots.version).toEqual({ kind: "text", value: pending.version.id });
    }
    expect(await approvals.get(pending.approvalId!)).toMatchObject({ status: "pending" });
    const reader = { ...author, authority: { ...author.authority, credentialKind: "oauth" as const, scopes: ["core:read"] } };
    await expect(reviewCodeVersionSubmission(input(code, "third", pending.version.id), reader)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(reviewCodeExecutionChange(code.id, true, reader)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("submission and decision bindings remain JSON objects in durable storage", async () => {
    const code = await newCode();
    const pending = await submitCodeVersion(input(code, "binding"), author);
    const [submission] =
      await sql`SELECT jsonb_typeof(binding) AS kind,binding FROM code.version_submissions WHERE version_id=${pending.version.id}::uuid`;
    expect(submission).toEqual({ kind: "object", binding: pending.binding });
    await decideCodeVersion(pending.binding, true, reviewer);
    const [decision] =
      await sql`SELECT jsonb_typeof(binding) AS kind,binding FROM code.version_decisions WHERE version_id=${pending.version.id}::uuid`;
    expect(decision).toEqual({ kind: "object", binding: pending.binding });
  });
  test("pending approval leaves the old approved version running and the diff retains unchanged rows/files", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "first\nold\nlast\n"), author);
    await decideCodeVersion(first.binding, true, reviewer);
    await activate(code, first);
    const next = await submitCodeVersion(input(code, "first\nnew\nlast\n", first.version.id), author);
    expect(next.status).toBe("pending");
    expect(await findCode(code.id)).toMatchObject({ state: "active", activeVersionId: first.version.id });
    const diff = await diffCodeVersion({ codeId: code.id, versionId: next.version.id }, reviewer);
    expect(diff.binding.comparisonVersionId).toBe(first.version.id);
    expect(diff.staleComparison).toBe(false);
    expect(diff.files).toEqual([
      {
        path: "code.ts",
        lines: [
          { kind: "same", text: "first" },
          { kind: "del", text: "old" },
          { kind: "add", text: "new" },
          { kind: "same", text: "last" },
          { kind: "same", text: "" },
        ],
      },
      {
        path: "same.ts",
        lines: [
          { kind: "same", text: "export const unchanged = true;" },
          { kind: "same", text: "" },
        ],
      },
    ]);
    const request = await approvals.get(next.approvalId!);
    expect(request).toMatchObject({
      kind: "code_version",
      authorUserId: authorId,
      approverRole: "admin",
      assurance: "confirm",
      details: { ask: "changes_access", content: { kind: "page" } },
    });
    const { codeId, ...decisionInput } = next.binding;
    expect(request?.argsDigest).toBe(
      approvalArgsDigest({
        capability: "core.code.version.approve",
        target: { type: "core.code", id: codeId },
        refs: {},
        input: decisionInput,
      }),
    );
    const full = request?.details && "content" in request.details ? request.details.content : undefined;
    expect(full && full.kind === "page" ? JSON.parse(full.body).files : null).toEqual(diff.files);
    await expect(sql.begin((tx) => requireCodeVersionApproval(code, next.version.id, tx))).rejects.toMatchObject({
      code: "code_approval_required",
    });
  });
  test("a checked automatic version needs no admin request and becomes the comparison after activation", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "auto", null, ["read"]), author);
    expect(first).toMatchObject({ status: "submitted", approvalId: null });
    await activate(code, first);
    const second = await submitCodeVersion(input(code, "next", first.version.id), author);
    expect(second.binding.comparisonVersionId).toBe(first.version.id);
  });
  test("source and bundle hashes are checked at submission and decision, before any transition", async () => {
    const code = await newCode();
    for (const key of ["source", "bundle"] as const) {
      const bad = input(code, "new");
      bad.manifest.hashes[key] = "0".repeat(64);
      await expect(submitCodeVersion(bad, author)).rejects.toMatchObject({ code: "code_hash_mismatch" });
    }
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
    const submission = await submitCodeVersion(input(code, "valid"), author);
    for (const key of ["sourceHash", "bundleHash", "manifestHash"] as const)
      await expect(decideCodeVersion({ ...submission.binding, [key]: "0".repeat(64) }, true, reviewer)).rejects.toMatchObject({
        code: "code_hash_mismatch",
      });
    expect(await approvals.get(submission.approvalId!)).toMatchObject({ status: "pending" });
    expect(await sql`SELECT * FROM code.version_decisions WHERE version_id=${submission.version.id}::uuid`).toHaveLength(0);
  });
  test("C5 forbids author self-approval when two human admins exist", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "valid"), author);
    await expect(decideCodeVersion(submission.binding, true, author)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await approvals.get(submission.approvalId!)).toMatchObject({ status: "pending", soleAdmin: false });
  });
  test("sole admin approves through C5 with recent sign-in, flag, audit and version-list label; machines and disabled admins do not count", async () => {
    await sql`UPDATE auth.users SET account_expires='2000-01-01' WHERE id=${reviewerId}::uuid`;
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "valid"), author);
    const signIn = await createTestBrowserSignIn(authorId);
    const signed: CodeContext = {
      ...author,
      authority: {
        ...author.authority,
        credentialProof: { kind: "session", userId: authorId, sid: signIn.sid, authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
      },
    };
    const result = await decideCodeVersion(submission.binding, true, signed);
    expect(result.decision).toMatchObject({ approved: true, soleAdmin: true, label: "selbst freigegeben (einziger Admin)" });
    expect(
      await sql<{ sole_admin: boolean }[]>`SELECT sole_admin FROM code.version_decisions WHERE version_id=${submission.version.id}::uuid`,
    ).toEqual([{ sole_admin: true }]);
    const events = await sql`SELECT reason,metadata FROM audit.events WHERE action='core.code.version.approved' AND target_id=${code.id}`;
    expect(events[0]).toMatchObject({
      reason: "self_approved_sole_admin",
      metadata: { sole_admin: true, soleAdmin: true, event: "version.approved" },
    });
    expect((await listCodeVersions({ codeId: code.id, limit: 20 }, signed)).items[0]?.decision?.label).toBe(
      "selbst freigegeben (einziger Admin)",
    );
    // Adding another admin cannot revoke the old decision, but the next self-approval is forbidden.
    await sql`UPDATE auth.users SET account_expires=NULL WHERE id=${reviewerId}::uuid`;
    await expect(sql.begin((tx) => requireCodeVersionApproval(code, submission.version.id, tx))).resolves.toEqual({ policyRevision: 1 });
    const next = await submitCodeVersion(input(code, "next", submission.version.id), author);
    await expect(decideCodeVersion(next.binding, true, signed)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await approvals.get(submission.approvalId!))?.soleAdmin).toBe(true);
  });
  test("sole-admin self-approval still requires C5's browser confirmation", async () => {
    await sql`UPDATE auth.users SET admin=false WHERE id=${reviewerId}::uuid`;
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "valid"), author);
    await expect(decideCodeVersion(submission.binding, true, author)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Version decision refused: REAUTHENTICATE.",
    });
  });
  test("approval/rejection via shared C5 service writes one durable receipt and exact hash coverage", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "valid"), author);
    const decide = () =>
      approvals.decide(
        submission.approvalId!,
        { approved: true },
        { userId: reviewerId, via: "web_session", authority: reviewer.authority },
      );
    expect(await decide()).toEqual({ ok: true, status: "approved", replay: false });
    expect(await decide()).toEqual({ ok: true, status: "approved", replay: true });
    expect(await sql<{ row: string }[]>`SELECT row FROM code.policy_coverage WHERE version_id=${submission.version.id}::uuid`).toEqual([
      { row: "silent_shared" },
    ]);
    expect(
      await sql<
        { binding: unknown; sole_admin: boolean }[]
      >`SELECT binding,sole_admin FROM code.version_decisions WHERE version_id=${submission.version.id}::uuid`,
    ).toEqual([{ binding: submission.binding, sole_admin: false }]);
    expect(await sql`SELECT id FROM audit.events WHERE action='core.code.version.approved' AND target_id=${code.id}`).toHaveLength(1);
    const next = await submitCodeVersion(input(code, "rejected", submission.version.id), author);
    expect((await decideCodeVersion(next.binding, false, reviewer)).status).toBe("rejected");
    expect(await sql<{ row: string }[]>`SELECT row FROM code.policy_coverage WHERE version_id=${next.version.id}::uuid`).toHaveLength(0);
    const rejectedEvents = await sql`SELECT metadata FROM audit.events WHERE action='core.code.version.rejected' AND target_id=${code.id}`;
    expect(Array.from(rejectedEvents)).toEqual([
      {
        metadata: {
          ...next.binding,
          event: "version.rejected",
          approvalId: next.approvalId,
          sole_admin: false,
          soleAdmin: false,
          decidedVia: "web_session",
        },
      },
    ]);
    await expect(sql.begin((tx) => requireCodeVersionApproval(code, next.version.id, tx))).rejects.toMatchObject({
      code: "code_approval_revoked",
    });
  });
  test("a newer push atomically cancels superseded requests and neither decision can use them", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "first"), author);
    const next = await submitCodeVersion(input(code, "next", first.version.id), author);
    for (const approved of [true, false])
      expect(
        await approvals.decide(first.approvalId!, { approved }, { userId: reviewerId, via: "web_session", authority: reviewer.authority }),
      ).toMatchObject({ ok: false, code: "ALREADY_DECIDED" });
    expect(await approvals.get(first.approvalId!)).toMatchObject({ status: "cancelled" });
    expect(await approvals.get(next.approvalId!)).toMatchObject({ status: "pending" });
    expect(await sql`SELECT version_id FROM code.version_decisions WHERE version_id=${first.version.id}::uuid`).toHaveLength(0);
  });
  test("a changed comparison is refused and the platform decision rolls back", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "first", null, ["read"]), author);
    const next = await submitCodeVersion(input(code, "next", first.version.id), author);
    expect(next.binding.comparisonVersionId).toBe(null);
    await activate(code, first);
    const changed = await diffCodeVersion({ codeId: code.id, versionId: next.version.id }, reviewer);
    expect(changed).toMatchObject({ staleComparison: true, binding: { comparisonVersionId: first.version.id } });
    await expect(decideCodeVersion(next.binding, true, reviewer)).rejects.toMatchObject({ code: "code_comparison_stale" });
    await expect(decideCodeVersion(changed.binding, true, reviewer)).rejects.toMatchObject({ code: "code_comparison_stale" });
    await expect(decideCodeVersion(next.binding, false, reviewer)).rejects.toMatchObject({ code: "code_comparison_stale" });
    expect(await approvals.get(next.approvalId!)).toMatchObject({ status: "pending" });
    await submitCodeVersion(input(code, "review again", next.version.id), author);
    expect(await approvals.get(next.approvalId!)).toMatchObject({ status: "cancelled" });
    expect(await findCode(code.id)).toMatchObject({ activeVersionId: first.version.id });
  });
  test("decided versions retain their original comparison after approval advances the baseline", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "before", null, ["read"]), author);
    await activate(code, first);
    const next = await submitCodeVersion(input(code, "after", first.version.id), author);
    const before = await diffCodeVersion({ codeId: code.id, versionId: next.version.id }, reviewer);
    await decideCodeVersion(next.binding, true, reviewer);
    expect(await diffCodeVersion({ codeId: code.id, versionId: next.version.id }, reviewer)).toEqual(before);
  });
  test("deleting Code returns an expected decision conflict and preserves the pending request", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "pending"), author);
    await sql`UPDATE code.codes SET state='deleting' WHERE id=${code.id}`;
    await expect(
      approvals.decide(
        submission.approvalId!,
        { approved: true },
        { userId: reviewerId, via: "web_session", authority: reviewer.authority },
      ),
    ).rejects.toMatchObject({ code: "code_version_unavailable" });
    expect(await approvals.get(submission.approvalId!)).toMatchObject({ status: "pending" });
  });
  test("the direct decision review includes C5's sole-admin notice", async () => {
    await sql`UPDATE auth.users SET admin=false WHERE id=${reviewerId}::uuid`;
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "review"), author);
    const review = await reviewCodeVersionDecision(submission.binding, true, author);
    expect(review.consequences?.[0]?.text).toContain("Admin");
    await sql`UPDATE auth.users SET admin=true WHERE id=${reviewerId}::uuid`;
    expect((await reviewCodeVersionDecision(submission.binding, true, author)).consequences).toBeUndefined();
  });
  test("an admin's ordinary write credential can pause and resume their personal Code", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "automatic", null, ["read"]), author);
    await activate(code, submission);
    const writer: CodeContext = { ...author, authority: { ...author.authority, credentialKind: "oauth", scopes: ["core:write"] } };
    expect(await setCodePaused(code.id, true, writer)).toEqual({ state: "paused" });
    expect(await setCodePaused(code.id, false, writer)).toEqual({ state: "active" });
  });
  test("deleting the reviewer conservatively revokes approval while retaining its decision", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "approved"), author);
    await decideCodeVersion(submission.binding, true, reviewer);
    await activate(code, submission);
    await setCodePaused(code.id, true, author);
    try {
      await sql`DELETE FROM auth.users WHERE id=${reviewerId}::uuid`;
      await expect(setCodePaused(code.id, false, author)).rejects.toMatchObject({ code: "code_approval_revoked" });
      expect((await listCodeVersions({ codeId: code.id, limit: 50 }, author)).items[0]?.decision).toMatchObject({
        approved: true,
        decidedBy: null,
      });
    } finally {
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${reviewerId}::uuid,${reviewerId},'local','user',true) ON CONFLICT(id) DO NOTHING`;
    }
  });
  test("complete comparison JSON is readable in stable bounded chunks even above the capability budget", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "before", null, ["read"]), author);
    const next = await submitCodeVersion(input(code, "after\n".repeat(40_000), first.version.id, ["read"]), author);
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const result = await readCodeVersionDiff(
        { codeId: code.id, versionId: next.version.id, comparisonVersionId: first.version.id, offset, length: 65_536 },
        author,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
      chunks.push(result.content.text);
      if (result.content.nextOffset === null) break;
      offset = result.content.nextOffset;
    }
    const complete = chunks.join("");
    expect(Buffer.byteLength(complete)).toBeGreaterThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(JSON.parse(complete)).toEqual(
      codeVersionDiff(input(code, "before").sourceFiles, input(code, "after\n".repeat(40_000)).sourceFiles, "replacement"),
    );
  });
  test("history pages obey the byte budget and preserve read's file ordering", async () => {
    const code = await newCode();
    let previous: string | null = null;
    for (let n = 0; n < 8; n++) {
      const draft = input(code, `version ${n}`, previous, ["read"]);
      for (let file = 0; file < 90; file++) draft.sourceFiles[`${file}_${"a".repeat(480)}.ts`] = "x";
      draft.sourceFiles["B.ts"] = "B";
      draft.sourceFiles["a.ts"] = "a";
      draft.sourceFiles["😀.ts"] = "unicode";
      draft.sourceFiles["\uE000.ts"] = "private use";
      draft.manifest.hashes.source = codeSourceHash(draft.sourceFiles, draft.manifest.entry);
      previous = (await submitCodeVersion(draft, author)).version.id;
    }
    const page = await listCodeVersions({ codeId: code.id, limit: 50 }, author);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(8);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(page.items[0]?.version.files).toEqual(
      (await readCodeVersion({ codeId: code.id, versionId: previous!, offset: 0, length: 1 }, author)).version.files,
    );
    const following = await listCodeVersions({ codeId: code.id, limit: 50, before: page.nextBefore! }, author);
    expect([...page.items, ...following.items].map((item) => item.version.number)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
  test("code:false retains personal authority but excludes resource-owned Code", async () => {
    const code = await newCode(),
      draft = input(code, "personal");
    draft.manifest.permissions[0]!.operation = "example.item.person_only";
    const personal = await submitCodeVersion(draft, author);
    expect(personal.status).toBe("pending");
    const ownerReader = spyOn(provider, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: true,
      data: { data: { view: { title: "Fixture item", permission: "admin" } } },
    });
    try {
      const resourceCode = await createCode(
        { owner: { kind: "resource", ref: { type: "example.item", id: "item" } }, title: "Resource Code" },
        author,
      );
      const resource = input(resourceCode, "resource");
      resource.manifest.permissions[0]!.operation = "example.item.person_only";
      await expect(submitCodeVersion(resource, author)).rejects.toMatchObject({
        code: "code_manifest_invalid",
        message: "Manifest operation is unavailable to Code.",
      });
      expect(await sql`SELECT id FROM code.versions WHERE code_id=${resourceCode.id}`).toHaveLength(0);
      expect(await approvals.get(personal.approvalId!)).toMatchObject({ status: "pending" });
    } finally {
      ownerReader.mockRestore();
    }
  });
  test("catalog classifications cannot be understated and sends remain refused when omitted from policyRows", async () => {
    const code = await newCode();
    for (const [operation, codeExpected] of [
      ["example.item.delete", "code_manifest_invalid"],
      ["example.item.send", "code_sends_not_yet"],
    ]) {
      const draft = input(code, "understated", null, ["read"]);
      draft.manifest.permissions[0]!.operation = operation!;
      await expect(submitCodeVersion(draft, author)).rejects.toMatchObject({ code: codeExpected });
    }
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
  });
  test("two concurrent pushes from the same base yield one complete version and one conflict with the full difference", async () => {
    const code = await newCode(),
      base = await submitCodeVersion(input(code, "base", null, ["read"]), author);
    const results = await Promise.allSettled([
      submitCodeVersion(input(code, "left", base.version.id), author),
      submitCodeVersion(input(code, "right", base.version.id), author),
    ]);
    const won = results.find((result) => result.status === "fulfilled");
    const lost = results.find((result) => result.status === "rejected");
    if (!won || won.status !== "fulfilled" || !lost || lost.status !== "rejected") throw new Error("Expected exactly one winning push");
    expect(lost.reason).toMatchObject({
      code: "code_version_conflict",
      message: expect.stringContaining("Neuere Version vorhanden"),
      details: {
        latestVersionId: won.value.version.id,
        files: expect.arrayContaining([
          {
            path: "same.ts",
            lines: [
              { kind: "same", text: "export const unchanged = true;" },
              { kind: "same", text: "" },
            ],
          },
        ]),
      },
    });
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(2);
    expect(await sql`SELECT version_id FROM code.version_submissions WHERE code_id=${code.id}`).toHaveLength(2);
  });
  test("sending is refused with code_sends_not_yet even when policy says automatic", async () => {
    await sql`UPDATE code.policy_rules SET value='automatic' WHERE row='ask_sends'`;
    const code = await newCode();
    await expect(submitCodeVersion(input(code, "send", null, ["ask_sends"]), author)).rejects.toMatchObject({ code: "code_sends_not_yet" });
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
  });
  test("policy veto and bad checker locations leave neither a saved version nor an approval", async () => {
    const code = await newCode(),
      bad = input(code, "bad");
    const missingEntry = input(code, "bad");
    missingEntry.manifest.entry = "missing.ts";
    missingEntry.manifest.hashes.source = codeSourceHash(missingEntry.sourceFiles, "missing.ts");
    await expect(submitCodeVersion(missingEntry, author)).rejects.toMatchObject({ code: "code_manifest_invalid" });
    const badEntrypoint = input(code, "bad");
    badEntrypoint.manifest.entrypoints[0]!.file = "missing.ts";
    await expect(submitCodeVersion(badEntrypoint, author)).rejects.toMatchObject({ code: "code_manifest_invalid" });
    badEntrypoint.manifest.entrypoints[0]!.file = "code.ts";
    badEntrypoint.manifest.entrypoints[0]!.line = 100;
    await expect(submitCodeVersion(badEntrypoint, author)).rejects.toMatchObject({ code: "code_manifest_invalid" });
    bad.manifest.permissions[0]!.line = 100;
    await expect(submitCodeVersion(bad, author)).rejects.toMatchObject({ code: "code_manifest_invalid" });
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='silent_shared'`;
    await expect(submitCodeVersion(input(code, "blocked"), author)).rejects.toMatchObject({ code: "code_policy_never" });
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
  });
  test("pause/resume checks current policy and active-version approval; a pending new version stays pending", async () => {
    const code = await newCode(),
      first = await submitCodeVersion(input(code, "approved"), author);
    await decideCodeVersion(first.binding, true, reviewer);
    await activate(code, first);
    const next = await submitCodeVersion(input(code, "pending", first.version.id), author);
    expect(await setCodePaused(code.id, true, author)).toEqual({ state: "paused" });
    expect(await setCodePaused(code.id, true, author)).toEqual({ state: "paused" });
    expect(await setCodePaused(code.id, false, author)).toEqual({ state: "active" });
    expect(await findCode(code.id)).toMatchObject({ activeVersionId: first.version.id, pauseReason: null });
    expect(await approvals.get(next.approvalId!)).toMatchObject({ status: "pending" });
    await setCodePaused(code.id, true, reviewer);
    await sql`UPDATE code.policy_rules SET value='never' WHERE row='silent_shared'`;
    await expect(setCodePaused(code.id, false, author)).rejects.toMatchObject({ code: "code_policy_never" });
    expect((await findCode(code.id))?.state).toBe("paused");
    expect(
      await sql<
        { action: string }[]
      >`SELECT action FROM audit.events WHERE target_id=${code.id} AND action IN ('core.code.paused','core.code.resumed') ORDER BY id`,
    ).toEqual([{ action: "core.code.paused" }, { action: "core.code.resumed" }, { action: "core.code.paused" }]);
  });
  test("durable approval survives platform-request pruning but sign-out epoch revocation blocks resume", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "approved"), author);
    await decideCodeVersion(submission.binding, true, reviewer);
    await activate(code, submission);
    await sql`DELETE FROM approvals.requests WHERE id=${submission.approvalId}::uuid`;
    expect((await listCodeVersions({ codeId: code.id, limit: 20 }, author)).items[0]?.status).toBe("approved");
    await setCodePaused(code.id, true, author);
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${reviewerId}::uuid`;
    await expect(setCodePaused(code.id, false, author)).rejects.toMatchObject({ code: "code_approval_revoked" });
  });
  test("Cloud Login device revocation invalidates a Code approval before resume", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "approved"), author);
    const deviceId = "55555555-5555-4555-8555-555555555555";
    await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted) VALUES(${deviceId}::uuid,'https://cloud.test',${reviewerId}::uuid,'Reviewer','{}'::jsonb,false)`;
    expect(
      await approvals.decide(submission.approvalId!, { approved: true }, { userId: reviewerId, via: "cloud_login", deviceId }),
    ).toMatchObject({ ok: true });
    await activate(code, submission);
    await setCodePaused(code.id, true, author);
    await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${deviceId}::uuid`;
    await expect(setCodePaused(code.id, false, author)).rejects.toMatchObject({ code: "code_approval_revoked" });
  });
  test("strangers cannot read full diffs, submit, or pause; explicit editors can submit", async () => {
    const code = await newCode(),
      submission = await submitCodeVersion(input(code, "private"), author);
    await expect(diffCodeVersion({ codeId: code.id, versionId: submission.version.id }, context(strangerId))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(submitCodeVersion(input(code, "foreign", submission.version.id), context(strangerId))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(setCodePaused(code.id, true, context(strangerId))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await addCodeShare(code.id, { type: "user", userId: strangerId }, "editor", author);
    expect((await submitCodeVersion(input(code, "shared", submission.version.id), context(strangerId))).status).toBe("pending");
  });
  test("read-only and phone credentials cannot submit lasting authority", async () => {
    const code = await newCode();
    const readOnly: CodeContext = { authority: { ...author.authority, credentialKind: "oauth", scopes: ["read"] } };
    await expect(submitCodeVersion(input(code, "denied"), readOnly)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const phone: CodeContext = { authority: { ...author.authority, actor: { kind: "user", user: person(authorId), sessionKind: "app" } } };
    await expect(submitCodeVersion(input(code, "denied"), phone)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// Imported session-fixture cleanup runs at file scope, after the suite's hooks.
// Keep its database alive until those session/signing-key deletes have finished.
afterAll(async () => {
  await database?.drop();
});
