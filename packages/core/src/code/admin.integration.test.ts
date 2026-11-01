import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { User } from "@k2b/cloud/contracts";
import { countPending } from "@k2b/cloud/services/approvals";
import { z } from "zod";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import type { CodeContext } from "./access";
import {
  codeAdminOwnerNames,
  listCodeAdminApprovals,
  listCodeAdminCleanup,
  listCodeAdminCodes,
  listCodeAdminDecided,
  readCodeAdminApproval,
  readCodeAdminCode,
  readCodeAdminEffective,
  readCodeAdminPolicy,
  readCodeAdminPolicyHistory,
  readCodeAdminRunners,
  readCodeAdminSummary,
} from "./admin";
import * as authoringChecks from "./authoring-check";
import type { CodeSourceFiles } from "./contracts";
import { readCodePolicySnapshot, updateCodePolicy } from "./policy";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash, insertCodeRun } from "./store";
import type { CodeCheckedVersionManifest } from "./version-contracts";
import { decideCodeVersion, startCodeVersionApprovals, submitCodeVersion } from "./versions";
import { readCodeWorkload } from "./workload-reader";

const operation = {
  title: "Read item",
  description: "Fixture operation.",
  openWorld: false,
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  run: () => ({ ok: true as const, data: { data: {} } }),
};
const catalog = compileCapabilityManifest("example", {
  protocolVersion: 2,
  queries: { "item.read": operation },
  actions: {
    "item.change": {
      ...operation,
      title: "Change item",
      destructive: false,
      idempotency: "none",
      policy: { silent: "shared" },
      review: () => ({
        ok: true as const,
        data: {
          locale: "en",
          slots: {},
          sentence: { action: "Change", running: "Changing", done: "Changed", confirm: "Confirm", decline: "Cancel" },
        },
      }),
    },
  },
});
const fixed = new Date("2026-11-01T12:00:00.000Z");
const authorId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const strangerId = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";
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
const context = (id: string): CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
  locale: "de",
});
const author = context(authorId),
  reviewer = context(reviewerId),
  stranger = context(strangerId);
const submission = (codeId: string, source: string, baseVersionId: string | null) => {
  const sourceFiles: CodeSourceFiles = { "code.ts": source };
  const bundle = `bundle:${source}`;
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.ts",
    hashes: { source: codeSourceHash(sourceFiles, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
    entrypoints: [{ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1", file: "code.ts", line: 1 }],
    ai: false,
    policyRows: ["silent_shared"],
    permissions: [{ operation: "example.item.change", target: { type: "example.item", id: "item_1" }, file: "code.ts", line: 2 }],
  };
  return { codeId, sourceFiles, bundle, manifest, baseVersionId };
};

databaseSuite()("C22 Administration › Code read model", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let dispose: (() => void) | undefined;
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let catalogSpy: ReturnType<typeof spyOn<typeof provider, "getCapabilityCatalogApp">>;
  let serverCheck: ReturnType<typeof spyOn<typeof authoringChecks, "verifyCodeSubmission">>;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useMigratedDatabase("core_code_admin");
    for (const [id, name] of [
      [authorId, "Lea Muster"],
      [reviewerId, "Ben Schulz"],
      [strangerId, "Tom Beispiel"],
    ] as const)
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name) VALUES(${id}::uuid,${id},'local','user',${id !== strangerId},${name})`;
    await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES(${groupId}::uuid,'buchhaltung','Buchhaltung','local')`;
    await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${authorId}::uuid,${groupId}::uuid)`;
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    serverCheck = spyOn(authoringChecks, "verifyCodeSubmission").mockResolvedValue();
    catalogSpy = spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "example", appName: "Example", appIcon: "ti ti-code", appDescription: "Fixture", manifest: catalog },
    });
    dispose = startCodeVersionApprovals();
  }, 180_000);
  afterAll(async () => {
    dispose?.();
    settingsSpy?.mockRestore();
    catalogSpy?.mockRestore();
    serverCheck?.mockRestore();
    await database?.drop();
    setSystemTime();
  });

  test("approvals, all Code, policy, effective rows and operations read through one admin gate", async () => {
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,created_at) VALUES('c_admin1','person',${authorId}::uuid,'Wochenbericht',${authorId}::uuid,${fixed})`;
    const first = await submitCodeVersion(submission("c_admin1", "export const one = 1;\nexample.item.change();", null), author);
    expect(first.status).toBe("pending");

    expect(await readCodeAdminSummary(reviewer)).toEqual({ approvals: 1, codes: 1, groups: 0, cleanup: 0 });
    const codeVersions = () =>
      countPending({ approverUserId: reviewerId, roleContext: { kind: "request", authority: reviewer.authority }, kind: "code_version" });
    expect((await codeVersions()).total).toBe(1);
    // The sidebar hint runs with a short lock and statement budget and still counts exactly.
    expect(
      (
        await countPending({
          approverUserId: reviewerId,
          roleContext: { kind: "request", authority: reviewer.authority },
          kind: "code_version",
          timeoutMs: 250,
        })
      ).total,
    ).toBe(1);
    const {
      items: [item],
      nextCursor,
    } = await listCodeAdminApprovals(reviewer);
    expect(nextCursor).toBeNull();
    expect(item).toMatchObject({
      codeId: "c_admin1",
      versionId: first.version.id,
      number: 1,
      title: "Wochenbericht",
      author: { id: authorId, name: "Lea Muster" },
      rows: ["silent_shared"],
      stat: { first: true, added: 2, removed: 0, lines: 2, files: 1 },
    });

    const review = await readCodeAdminApproval(first.version.id, reviewer);
    expect(review).toMatchObject({
      status: "pending",
      canApprove: true,
      own: false,
      soleAdminNotice: null,
      staleComparison: false,
      comparison: null,
      newer: null,
      why: [{ row: "silent_shared", source: "default", groups: [] }],
      permissions: [{ operation: "example.item.change", change: "added", file: "code.ts", line: 2 }],
      titles: { operations: { "example.item.change": "Change item" } },
    });
    expect(review.binding).toEqual(first.binding);
    expect(review.files?.[0]?.lines.map((line) => line.kind)).toEqual(["add", "add"]);
    // Two admins: the author sees their own version but cannot approve it.
    expect(await readCodeAdminApproval(first.version.id, author)).toMatchObject({ own: true, canApprove: false });

    const codes = await listCodeAdminCodes({}, reviewer);
    expect(codes).toMatchObject({ total: 1, owners: 1, nextCursor: null });
    expect(codes.items[0]).toMatchObject({ id: "c_admin1", status: "waiting", ownerName: "Lea Muster", lastRun: null });
    expect((await listCodeAdminCodes({ status: "waiting" }, reviewer)).total).toBe(1);
    expect((await listCodeAdminCodes({ status: "active" }, reviewer)).total).toBe(0);
    expect((await listCodeAdminCodes({ app: "person", q: "lea" }, reviewer)).total).toBe(1);
    expect((await listCodeAdminCodes({ app: "mail" }, reviewer)).total).toBe(0);
    expect((await listCodeAdminCodes({ q: "100%_" }, reviewer)).total).toBe(0);
    expect(await readCodeAdminCode("c_admin1", reviewer)).toMatchObject({
      pendingVersionId: first.version.id,
      runs: [],
      cleanup: [],
      versions: [{ status: "pending" }],
    });

    await decideCodeVersion(first.binding, true, reviewer);
    expect((await codeVersions()).total).toBe(0);
    expect(await listCodeAdminApprovals(reviewer)).toEqual({ items: [], nextCursor: null });
    expect(await listCodeAdminDecided(reviewer)).toEqual([
      expect.objectContaining({ versionId: first.version.id, approved: true, soleAdmin: false, decidedBy: "Ben Schulz" }),
    ]);
    expect(await readCodeAdminApproval(first.version.id, reviewer)).toMatchObject({
      status: "approved",
      canApprove: false,
      decision: { approved: true, decidedByName: "Ben Schulz" },
    });

    expect(await readCodeAdminPolicyHistory(reviewer)).toEqual([]);
    const current = await readCodePolicySnapshot();
    await updateCodePolicy(
      {
        revision: current.revision,
        definition: { preset: "custom", rules: [...current.definition.rules, { groupId, row: "ask_deletes", value: "automatic" }] },
      },
      reviewer,
    );
    expect(await readCodeAdminPolicyHistory(reviewer)).toEqual([
      {
        at: expect.any(String),
        by: "Ben Schulz",
        revision: current.revision + 1,
        preset: { before: current.definition.preset, after: "custom" },
        changes: [{ group: "Buchhaltung", row: "ask_deletes", before: null, after: "automatic" }],
      },
    ]);
    const policy = await readCodeAdminPolicy(reviewer);
    expect(policy.groups).toEqual([{ id: groupId, name: "Buchhaltung", rules: 1, members: 1, parents: [] }]);
    expect(policy.policy.revision).toBeGreaterThan(0);
    const effective = await readCodeAdminEffective(authorId, reviewer);
    expect(effective.person).toEqual({ id: authorId, name: "Lea Muster" });
    expect(effective.groups).toEqual([{ id: groupId, name: "Buchhaltung", parents: [] }]);
    expect(effective.rows.find((row) => row.row === "ask_deletes")).toEqual({
      row: "ask_deletes",
      value: "automatic",
      source: "group",
      groups: ["Buchhaltung"],
    });
    expect(await codeAdminOwnerNames(["c_admin1"], reviewer)).toEqual({ c_admin1: "Lea Muster" });
    expect(await listCodeAdminCleanup(reviewer)).toEqual({ items: [], nextCursor: null });
    expect(await readCodeAdminRunners(reviewer)).toMatchObject({ queued: 0, running: 0, instances: 0, freeSlots: 0, runners: [] });
  });

  test("the Code behind a change reads for those who may read it, and for nobody else", async () => {
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by,created_at) VALUES('c_origin','person',${authorId}::uuid,'Wochenbericht',${authorId}::uuid,${fixed})`;
    const version = await submitCodeVersion(submission("c_origin", "export const c = 3;\nexample.item.change();", null), author);
    const runId = await insertCodeRun({
      codeId: "c_origin",
      versionId: version.version.id,
      trigger: "schedule",
      entrypoint: "Lieferungen eintragen",
      input: null,
    });
    const read = await readCodeWorkload(`${version.version.id}~${runId}`, author);
    expect(read.view).toEqual({ title: "Wochenbericht", context: "Lieferungen eintragen", permission: "write" });
    // A person's Code has no owner page to link to.
    expect(read.links).toEqual([]);
    expect((await readCodeWorkload(version.version.id, author)).view.context).toBeUndefined();
    for (const id of [
      `${version.version.id}~${runId}`,
      "not-a-version",
      `${version.version.id}~nope`,
      "e0000000-0000-4000-8000-000000000009",
    ])
      await expect(readCodeWorkload(id, stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("people without the Cloud-admin role read nothing", async () => {
    for (const read of [
      () => readCodeAdminSummary(stranger),
      () => listCodeAdminApprovals(stranger),
      () => listCodeAdminDecided(stranger),
      () => listCodeAdminCodes({}, stranger),
      () => readCodeAdminCode("c_admin1", stranger),
      () => readCodeAdminPolicy(stranger),
      () => readCodeAdminPolicyHistory(stranger),
      () => readCodeAdminEffective(authorId, stranger),
      () => listCodeAdminCleanup(stranger),
      () => readCodeAdminRunners(stranger),
      () => codeAdminOwnerNames(["c_admin1"], stranger),
    ])
      await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
