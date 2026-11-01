import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { reviewFixture } from "../../_internal/capability-review.test-fixture";
import { migrateCloudAi } from "../../ai/migrate";
import { sql } from "../../runtime/clients";
import type { RequestAuthority } from "../../server/middleware/auth";
import { get as getUser } from "../accounts/users";
import { createTestBrowserSignIn } from "../session/session.test-fixture";
import { encryptValue } from "../settings/crypto";
import {
  approvalReviewDigest,
  approvals,
  type CodeVersionApprovalRequestInput,
  countPending,
  listPending,
  migrateApprovals,
  registerApprovalDecisionHandler,
} from ".";
import { readApprovalContent } from "./content";
import { soleCodeAdmin } from "./policy";

// Each suite receives an isolated test database from the shared infrastructure gate.
databaseSuite()("independent Code-version approvals", () => {
  const users: string[] = [];
  const requests: string[] = [];
  let author = "",
    admin = "",
    otherAdmin = "",
    outsider = "";
  let dispose: (() => void) | undefined;
  let failTransition = false;
  let transitions = 0;
  let transitionSoleAdmin = false;
  const install = () =>
    registerApprovalDecisionHandler("code_version", async (tx, request) => {
      transitions++;
      transitionSoleAdmin = request.soleAdmin;
      await tx`UPDATE auth.users SET display_name=${`version:${request.status}`} WHERE id=${author}::uuid`;
      if (failTransition) throw new Error("Version transition failed");
    });
  beforeAll(async () => {
    await migrateCloudAi();
    for (const [name, isAdmin] of [
      ["author", true],
      ["admin", true],
      ["second-admin", true],
      ["outsider", false],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
        VALUES (${`code-approval-${name}-${crypto.randomUUID()}`},'local','user',${isAdmin}) RETURNING id`;
      if (!row) throw new Error("Missing fixture user");
      users.push(row.id);
      if (name === "author") author = row.id;
      else if (name === "admin") admin = row.id;
      else if (name === "second-admin") otherAdmin = row.id;
      else outsider = row.id;
    }
    dispose = install();
  });
  afterAll(async () => {
    dispose?.();
    for (const id of requests) await sql`DELETE FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`;
    for (const id of requests) await sql`DELETE FROM approvals.requests WHERE id=${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
  });
  const snapshot = (): CodeVersionApprovalRequestInput => ({
    kind: "code_version",
    appId: "demo",
    action: "version.approve",
    requester: { kind: "code_version", ref: crypto.randomUUID(), appId: "demo", title: "Monday report", href: "/code/demo/" },
    authorUserId: author,
    approverRole: "admin",
    sentence: "Approve this version of Monday report?",
    input: { codeId: "demo", versionId: "v1", sourceHash: "a".repeat(64), bundleHash: "b".repeat(64) },
    review: { ...reviewFixture(), content: { kind: "page", title: "Source diff", body: "- old\n+ new", format: "plain" } },
    expiresInMs: 600_000,
  });
  const ask = async (input = snapshot()) => {
    const result = await approvals.request(input);
    if (!result.ok) throw new Error("Expected a request");
    requests.push(result.id);
    return { id: result.id, input };
  };
  const authorityFor = async (userId: string, db: SQL = sql): Promise<RequestAuthority> => {
    const user = await getUser({ id: userId }, { db });
    if (!user) throw new Error("Missing authority user");
    return { actor: { kind: "user", user }, accessSubject: { type: "user", userId }, credentialKind: "session", scopes: [] };
  };
  const roleContext = async (userId: string) => ({ kind: "request" as const, authority: await authorityFor(userId) });
  const decide = async (id: string, userId = admin, approved = true) =>
    approvals.decide(
      id,
      { approved },
      {
        userId,
        via: "web_session",
        authority: await authorityFor(userId),
      },
    );

  // Roll back population fixtures and the decisions together; no admin state leaks to other cases.
  const withSoleAdmin = async (run: (tx: SQL) => Promise<void>) => {
    const rollback = new Error("sole admin fixture rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE auth.users SET admin=false WHERE id<>${author}::uuid AND admin`;
        await run(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  };
  const signedAuthor = async (sid: string, tx: SQL): Promise<RequestAuthority> => ({
    ...(await authorityFor(author, tx)),
    credentialProof: { kind: "session", userId: author, sid, authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z" },
  });
  const selfDecide = async (id: string, tx: SQL, authority: RequestAuthority) =>
    approvals.decide(id, { approved: true }, { userId: author, via: "web_session", authority }, tx);

  test("the sole human admin self-approves with durable decision evidence and an audit reason", async () => {
    const { id } = await ask();
    const signIn = await createTestBrowserSignIn(author);
    await withSoleAdmin(async (tx) => {
      expect(await soleCodeAdmin(tx)).toBe(author);
      expect(await selfDecide(id, tx, await signedAuthor(signIn.sid, tx))).toEqual({ ok: true, status: "approved", replay: false });
      expect(transitionSoleAdmin).toBe(true);
      expect(await approvals.get(id, tx)).toMatchObject({ status: "approved", soleAdmin: true, decidedByUserId: author });
      const [event] = await tx`SELECT metadata FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`;
      expect(event?.metadata).toMatchObject({ soleAdmin: true, reason: "self_approved_sole_admin" });
    });
  });

  test("a second admin blocks new self-approvals while old evidence and replays remain valid", async () => {
    const old = await ask(),
      next = await ask();
    const signIn = await createTestBrowserSignIn(author);
    await withSoleAdmin(async (tx) => {
      const authority = await signedAuthor(signIn.sid, tx);
      expect(await selfDecide(old.id, tx, authority)).toMatchObject({ ok: true, replay: false });
      await tx`UPDATE auth.users SET admin=true WHERE id=${admin}::uuid`;
      expect(await selfDecide(next.id, tx, authority)).toEqual({ ok: false, code: "SELF_APPROVAL" });
      expect(await selfDecide(old.id, tx, authority)).toEqual({ ok: true, status: "approved", replay: true });
      expect(await approvals.get(old.id, tx)).toMatchObject({ status: "approved", soleAdmin: true });
      expect(await approvals.get(next.id, tx)).toMatchObject({ status: "pending", soleAdmin: false });
    });
  });

  test("expired, guest and disabled-category admins do not enter the human population", async () => {
    const { id } = await ask();
    const signIn = await createTestBrowserSignIn(author);
    await withSoleAdmin(async (tx) => {
      await tx`UPDATE auth.users SET admin=true,account_expires='2000-01-01' WHERE id=${admin}::uuid`;
      await tx`UPDATE auth.users SET provider='ipa',admin=false,profile='guest' WHERE id=${otherAdmin}::uuid`;
      await tx`UPDATE auth.users SET provider='ipa' WHERE id=${outsider}::uuid`;
      await tx`INSERT INTO auth.ipa_user_effective_groups VALUES(${outsider}::uuid,'code-review-admins'),(${otherAdmin}::uuid,'code-review-admins')`;
      await tx`INSERT INTO settings.entries(key,value) VALUES
        ('freeipa.groups.admin',${await encryptValue(["code-review-admins"])}),
        ('user.category.freeipa.enabled',${await encryptValue(false)})
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      expect(await soleCodeAdmin(tx)).toBe(author);
      expect(await selfDecide(id, tx, await signedAuthor(signIn.sid, tx))).toMatchObject({ ok: true });
    });
  });

  test("active FreeIPA persons count as admins through the configured effective groups", async () => {
    const { id } = await ask();
    await withSoleAdmin(async (tx) => {
      await tx`UPDATE auth.users SET provider='ipa' WHERE id=${outsider}::uuid`;
      await tx`INSERT INTO auth.ipa_user_effective_groups VALUES(${outsider}::uuid,'code-review-admins')`;
      await tx`INSERT INTO settings.entries(key,value) VALUES('freeipa.groups.admin',${await encryptValue(["code-review-admins"])})
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      expect(await soleCodeAdmin(tx)).toBeNull();
      expect(await selfDecide(id, tx, await authorityFor(author, tx))).toEqual({ ok: false, code: "SELF_APPROVAL" });
    });
  });

  test("service and agent accounts with admin credential scope never count or become a sole human admin", async () => {
    const { id } = await ask();
    const signIn = await createTestBrowserSignIn(author);
    await withSoleAdmin(async (tx) => {
      for (const kind of ["standalone", "agent"] as const) {
        const [machine] = await tx<
          { id: string }[]
        >`INSERT INTO auth.service_accounts(name,kind) VALUES(${`Code ${kind}`},${kind}) RETURNING id`;
        if (!machine) throw new Error("Missing machine");
        const authority: RequestAuthority = {
          credentialKind: "api_key",
          scopes: ["admin"],
          accessSubject: { type: "service_account", serviceAccountId: machine.id },
          actor: {
            kind: "service_account",
            delegatedUser: null,
            scopes: ["admin"],
            serviceAccount: {
              id: machine.id,
              name: kind,
              kind,
              status: "active",
              delegatedUserId: null,
              appId: null,
              resourceType: null,
              resourceId: null,
              createdBy: null,
              createdAt: "2026-10-31T00:00:00Z",
            },
          },
        };
        expect(await approvals.decide(id, { approved: true }, { userId: machine.id, via: "api_key", authority }, tx)).toEqual({
          ok: false,
          code: "NOT_FOUND",
        });
      }
      expect(await soleCodeAdmin(tx)).toBe(author);
      expect(await selfDecide(id, tx, await signedAuthor(signIn.sid, tx))).toMatchObject({ ok: true });
      await tx`UPDATE auth.users SET admin=false WHERE id=${author}::uuid`;
      expect(await soleCodeAdmin(tx)).toBeNull();
    });
  });

  test("sole self-approval reuses recent browser sign-in or the active signed device path", async () => {
    const { id } = await ask();
    const signIn = await createTestBrowserSignIn(author);
    const deviceId = crypto.randomUUID();
    await withSoleAdmin(async (tx) => {
      expect(await selfDecide(id, tx, await authorityFor(author, tx))).toEqual({ ok: false, code: "REAUTHENTICATE" });
      await tx`UPDATE auth.session_families SET issued_at='2000-01-01' WHERE sid=${signIn.sid}::uuid`;
      expect(await selfDecide(id, tx, await signedAuthor(signIn.sid, tx))).toEqual({ ok: false, code: "REAUTHENTICATE" });
      await tx`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
        VALUES(${deviceId}::uuid,'https://cloud.example.test',${author}::uuid,'Phone','{}'::jsonb,false)`;
      expect(await approvals.decide(id, { approved: true }, { userId: author, via: "cloud_login", deviceId }, tx)).toMatchObject({
        ok: true,
      });
      expect(await approvals.get(id, tx)).toMatchObject({ soleAdmin: true, decidedDeviceId: deviceId });
    });
  });

  test("a caller retaining an older transaction snapshot cannot self-approve", async () => {
    const { id } = await ask();
    const rollback = new Error("isolation fixture rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
        await tx`UPDATE auth.users SET admin=false WHERE admin AND id<>${author}::uuid`;
        expect(await soleCodeAdmin(tx)).toBe(author);
        expect(await selfDecide(id, tx, await authorityFor(author, tx))).toEqual({ ok: false, code: "SELF_APPROVAL" });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  test("an in-flight second-admin promotion wins without aborting or stalling the decision transaction", async () => {
    const { id } = await ask();
    const authority = await authorityFor(author);
    await withSoleAdmin(async (tx) => {
      let promoted!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        promoted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rollback = new Error("promotion rollback");
      const promotion = sql
        .begin(async (writer) => {
          await writer`UPDATE auth.users SET admin=true WHERE id=${outsider}::uuid`;
          promoted();
          await released;
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      try {
        await Promise.race([
          ready,
          promotion.then(() => {
            throw new Error("Promotion never acquired its lock");
          }),
        ]);
        expect(await selfDecide(id, tx, authority)).toEqual({ ok: false, code: "BUSY" });
        expect(await approvals.get(id, tx)).toMatchObject({ status: "pending" });
        // A denied NOWAIT lock is contained in a savepoint, so this transaction remains usable.
        expect((await tx`SELECT 1 AS usable`)[0]?.usable).toBe(1);
      } finally {
        release();
        await promotion;
      }
    });
  });

  test("an author row lock fails busy before a waiting writer can cause a lock upgrade deadlock", async () => {
    const { id } = await ask();
    const authority = await authorityFor(author);
    await withSoleAdmin(async (tx) => {
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rollback = new Error("row writer rollback");
      const writer = sql
        .begin(async (connection) => {
          await connection`SELECT id FROM auth.users WHERE id=${author}::uuid FOR UPDATE`;
          locked();
          await released;
          await connection`UPDATE auth.users SET display_name='row-writer' WHERE id=${author}::uuid`;
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      try {
        await Promise.race([
          ready,
          writer.then(() => {
            throw new Error("Writer never acquired its row lock");
          }),
        ]);
        expect(await selfDecide(id, tx, authority)).toEqual({ ok: false, code: "BUSY" });
        expect((await tx`SELECT 1 AS usable`)[0]?.usable).toBe(1);
      } finally {
        release();
        await writer;
      }
    });
  });

  // These conflict tests need committed population fixtures: an uncommitted fixture UPDATE would itself cause BUSY.
  const withCommittedSoleAdmin = async (run: () => Promise<void>) => {
    const previous = await sql<{ id: string }[]>`UPDATE auth.users SET admin=false WHERE admin AND id<>${author}::uuid RETURNING id`;
    try {
      await run();
    } finally {
      for (const user of previous) await sql`UPDATE auth.users SET admin=true WHERE id=${user.id}::uuid`;
    }
  };

  test("overlapping self-approvals serialize before either handler writes accounts", async () => {
    const first = await ask(),
      next = await ask();
    const signIn = await createTestBrowserSignIn(author);
    await withCommittedSoleAdmin(async () => {
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rollback = new Error("overlap rollback");
      dispose?.();
      dispose = registerApprovalDecisionHandler("code_version", async (tx, request) => {
        if (request.id !== first.id) return;
        reached();
        await released;
        await tx`UPDATE auth.users SET display_name='overlap-handler' WHERE id=${author}::uuid`;
      });
      const firstDecision = sql
        .begin(async (tx) => {
          expect(await selfDecide(first.id, tx, await signedAuthor(signIn.sid, tx))).toMatchObject({ ok: true });
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      try {
        await Promise.race([
          ready,
          firstDecision.then(() => {
            throw new Error("First decision never reached its handler");
          }),
        ]);
        // No account write has run in the first decision: only the population lock can reject this overlap.
        expect(await decide(next.id, author)).toEqual({ ok: false, code: "BUSY" });
      } finally {
        release();
        try {
          await firstDecision;
        } finally {
          dispose?.();
          dispose = install();
        }
      }
    });
  });

  test("an ordinary role decision's retained settings lock blocks concurrent self-approval", async () => {
    const first = await ask(),
      next = await ask();
    await withCommittedSoleAdmin(async () => {
      dispose?.();
      dispose = registerApprovalDecisionHandler("code_version", async () => {});
      const rollback = new Error("role lock rollback");
      try {
        await expect(
          sql.begin(async (tx) => {
            expect(
              await approvals.decide(
                first.id,
                { approved: false },
                {
                  userId: author,
                  via: "web_session",
                  authority: await authorityFor(author, tx),
                },
                tx,
              ),
            ).toMatchObject({ ok: true });
            expect(await decide(next.id, author)).toEqual({ ok: false, code: "BUSY" });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      } finally {
        dispose?.();
        dispose = install();
      }
    });
  });

  test("a non-admin author is refused before taking population locks", async () => {
    const { id } = await ask({ ...snapshot(), authorUserId: outsider });
    await sql.begin(async (writer) => {
      await writer`LOCK TABLE auth.users IN ROW EXCLUSIVE MODE`;
      expect(await decide(id, outsider)).toEqual({ ok: false, code: "NOT_FOUND" });
    });
  });

  test("adds the role without rewriting existing personal approval rows", async () => {
    const input = snapshot();
    const result = await approvals.request({
      ...input,
      kind: "action",
      subjectId: outsider,
      requester: { ...input.requester, kind: "assistant_turn" },
      approverUserId: outsider,
      assurance: "standard",
    });
    if (!result.ok) throw new Error("Missing personal request");
    requests.push(result.id);
    const before = await approvals.get(result.id);
    await migrateApprovals();
    await migrateApprovals();
    expect(await approvals.get(result.id)).toEqual(before);
    expect(before).toMatchObject({ kind: "action", approverUserId: outsider, approverRole: null, status: "pending" });
    expect(await decide(result.id, admin)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(result.id, outsider)).toMatchObject({ ok: true, status: "approved" });
  });

  test("the database permits exactly one personal or role recipient and keeps Code confirmation mandatory", async () => {
    const { id } = await ask();
    // Bun SQL is lazy: the matcher alone does not start a raw Query. Execute it before asserting rejection.
    await expect(sql`UPDATE approvals.requests SET approver_user_id=${admin}::uuid WHERE id=${id}::uuid`.execute()).rejects.toMatchObject({
      errno: "23514",
    });
    await expect(sql`UPDATE approvals.requests SET approver_role=NULL WHERE id=${id}::uuid`.execute()).rejects.toMatchObject({
      errno: "23514",
    });
    await expect(sql`UPDATE approvals.requests SET assurance='standard' WHERE id=${id}::uuid`.execute()).rejects.toMatchObject({
      errno: "23514",
    });
    await expect(sql`UPDATE approvals.requests SET requester_kind='assistant_turn' WHERE id=${id}::uuid`.execute()).rejects.toMatchObject({
      errno: "23514",
    });
    expect(await approvals.get(id)).toMatchObject({ approverRole: "admin", approverUserId: null, assurance: "confirm", status: "pending" });
  });

  test("only a current Cloud admin decides; being the author or chat user grants nothing", async () => {
    const { id } = await ask();
    expect(await decide(id, outsider)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(id, outsider, false)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await decide(id, author)).toEqual({ ok: false, code: "SELF_APPROVAL" });
    expect(await approvals.get(id)).toMatchObject({ status: "pending", approverUserId: null, approverRole: "admin", assurance: "confirm" });
    const before = transitions;
    expect(await decide(id)).toEqual({ ok: true, status: "approved", replay: false });
    expect(await decide(id)).toEqual({ ok: true, status: "approved", replay: true });
    expect(transitions).toBe(before + 1);
    expect(await approvals.get(id)).toMatchObject({ decidedByUserId: admin, decidedVia: "web_session", status: "approved" });
    expect(await decide(id, otherAdmin, false)).toEqual({ ok: false, code: "ALREADY_DECIDED", status: "approved" });
    const [event] = await sql<{ actor_user_id: string; metadata: unknown }[]>`SELECT actor_user_id,metadata FROM audit.events
      WHERE target_type='approval_request' AND target_id=${id}`;
    expect(event).toMatchObject({ actor_user_id: admin, metadata: { kind: "code_version" } });
  });

  test("authors can reject; two admins cannot decide differently", async () => {
    const rejected = await ask();
    expect(await decide(rejected.id, author, false)).toMatchObject({ ok: true, status: "rejected" });
    const concurrent = await ask();
    const before = transitions;
    const results = await Promise.all([decide(concurrent.id, admin), decide(concurrent.id, otherAdmin, false)]);
    expect(results.filter((result) => result.ok && !result.replay)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "ALREADY_DECIDED")).toHaveLength(1);
    expect(transitions).toBe(before + 1);
  });

  test("an owner's failure rolls back platform decision, domain write and audit", async () => {
    const { id } = await ask();
    await sql`UPDATE auth.users SET display_name='before-failure' WHERE id=${author}::uuid`;
    failTransition = true;
    try {
      await expect(decide(id)).rejects.toThrow("Version transition failed");
    } finally {
      failTransition = false;
    }
    expect(await approvals.get(id)).toMatchObject({ status: "pending", decidedByUserId: null });
    const [user] = await sql<{ display_name: string }[]>`SELECT display_name FROM auth.users WHERE id=${author}::uuid`;
    expect(user?.display_name).toBe("before-failure");
    expect(await sql`SELECT id FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`).toHaveLength(0);
    expect(await decide(id)).toMatchObject({ ok: true });
  });

  test("without the kind owner, decisions remain visibly unavailable and pending", async () => {
    const { id } = await ask();
    dispose?.();
    try {
      expect(await decide(id)).toEqual({ ok: false, code: "UNAVAILABLE" });
    } finally {
      dispose = install();
    }
    expect(await approvals.get(id)).toMatchObject({ status: "pending" });
  });

  test("lists, counts and complete content require the role but no pending chat", async () => {
    const { id, input } = await ask();
    const digest = approvalReviewDigest(input.review);
    expect((await listPending({ approverUserId: admin, id, roleContext: await roleContext(admin) })).items[0]).toMatchObject({
      id,
      kind: "code_version",
      conversationShortId: null,
    });
    expect((await listPending({ approverUserId: outsider, id })).items).toEqual([]);
    expect((await countPending({ approverUserId: admin, roleContext: await roleContext(admin) })).apps.demo).toBeGreaterThan(0);
    expect((await countPending({ approverUserId: outsider })).total).toBe(0);
    expect(await readApprovalContent({ id, digest, approverUserId: admin, roleContext: await roleContext(admin) })).toEqual({
      kind: "page",
      title: "Source diff",
      body: "- old\n+ new",
      format: "plain",
    });
    expect(await readApprovalContent({ id, digest, approverUserId: outsider })).toBeNull();
    await sql`UPDATE auth.users SET admin=false WHERE id=${admin}::uuid`;
    try {
      expect((await listPending({ approverUserId: admin, id, roleContext: await roleContext(admin) })).items).toEqual([]);
      expect(await readApprovalContent({ id, digest, approverUserId: admin, roleContext: await roleContext(admin) })).toBeNull();
      expect(await decide(id)).toEqual({ ok: false, code: "NOT_FOUND" });
    } finally {
      await sql`UPDATE auth.users SET admin=true WHERE id=${admin}::uuid`;
    }
    await decide(id);
    expect(await readApprovalContent({ id, digest, approverUserId: admin, roleContext: await roleContext(admin) })).toBeNull();
  });

  test("FreeIPA admin roles use current configured groups, not the local admin flag", async () => {
    const { id } = await ask();
    const rollback = new Error("role fixture rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE auth.users SET provider='ipa',admin=false WHERE id=${outsider}::uuid`;
        await tx`INSERT INTO auth.ipa_user_effective_groups VALUES(${outsider}::uuid,'code-review-admins')`;
        await tx`INSERT INTO settings.entries(key,value) VALUES('freeipa.groups.admin',${await encryptValue(["code-review-admins"])})
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        expect(
          await approvals.decide(
            id,
            { approved: true },
            { userId: outsider, via: "web_session", authority: await authorityFor(outsider, tx) },
            tx,
          ),
        ).toMatchObject({ ok: true });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await approvals.get(id)).toMatchObject({ status: "pending" });
  });

  test("role questions survive the author's sign-out, expire normally, and cannot be rebound or consumed as chat consent", async () => {
    const { id, input } = await ask();
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${author}::uuid`;
    expect(await approvals.request(input)).toEqual({ ok: true, id });
    expect(await approvals.request({ ...input, input: { bundleHash: "changed" } })).toEqual({ ok: false, code: "CONFLICT" });
    expect(await decide(id)).toMatchObject({ ok: true });
    expect(await approvals.consume(id, { requester: input.requester, input: input.input, review: input.review ?? null })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    const expired = await ask();
    await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect(await decide(expired.id)).toEqual({ ok: false, code: "EXPIRED" });
  });

  test("deleting a version author does not cascade a role request", async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
      VALUES (${`deleted-author-${crypto.randomUUID()}`},'local','user') RETURNING id`;
    if (!user) throw new Error("Missing author");
    const { id } = await ask({ ...snapshot(), authorUserId: user.id });
    await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    expect(await approvals.get(id)).toMatchObject({ status: "pending", authorUserId: null, subjectId: null });
    expect(await decide(id)).toMatchObject({ ok: true });
  });

  test("version owners can keep a review pending beyond the Action wait budget", async () => {
    const lifetime = 7 * 24 * 60 * 60_000;
    const { id } = await ask({ ...snapshot(), expiresInMs: lifetime });
    const record = await approvals.get(id);
    expect(record!.expiresAt.getTime() - record!.createdAt.getTime()).toBe(lifetime);
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "web_session" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  test("credential ceilings and disabled account categories apply to role reads and decisions", async () => {
    const { id, input } = await ask();
    const authority = await authorityFor(admin);
    const restricted = { ...authority, credentialKind: "oauth" as const, scopes: ["write"] };
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "oauth", authority: restricted })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect((await listPending({ approverUserId: admin, id, roleContext: { kind: "request", authority: restricted } })).items).toEqual([]);
    expect(
      await readApprovalContent({
        id,
        approverUserId: admin,
        digest: approvalReviewDigest(input.review),
        roleContext: { kind: "request", authority: restricted },
      }),
    ).toBeNull();
    const phone = { ...authority, actor: { ...authority.actor, sessionKind: "app" as const } };
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "app_session", authority: phone })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    const rollback = new Error("category fixture rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO settings.entries(key,value) VALUES('user.category.login.enabled',${await encryptValue(false)})
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "web_session", authority }, tx)).toEqual({
          ok: false,
          code: "NOT_FOUND",
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await approvals.get(id)).toMatchObject({ status: "pending" });
  });

  test("ACP only rejects and Cloud Login requires a current device belonging to the admin", async () => {
    const { id } = await ask();
    expect(
      await approvals.decide(id, { approved: true }, { userId: admin, via: "acp_bridge", authority: await authorityFor(admin) }),
    ).toEqual({
      ok: false,
      code: "REJECT_ONLY",
    });
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login" })).toEqual({ ok: false, code: "NOT_FOUND" });
    const deviceId = crypto.randomUUID();
    await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
      VALUES (${deviceId}::uuid,'https://cloud.example.test',${admin}::uuid,'Phone','{}'::jsonb,false)`;
    expect(await approvals.decide(id, { approved: true }, { userId: otherAdmin, via: "cloud_login", deviceId })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${deviceId}::uuid`;
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login", deviceId })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    await sql`UPDATE auth.app_devices SET revoked_at=NULL WHERE id=${deviceId}::uuid`;
    expect(await approvals.decide(id, { approved: true }, { userId: admin, via: "cloud_login", deviceId })).toMatchObject({ ok: true });
    expect(await approvals.get(id)).toMatchObject({ decidedByUserId: admin, decidedDeviceId: deviceId });
  });
});
