import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { parsePgJsonRecord, toPgTextArray } from "../postgres";
import { MANDATE_MAX_PENDING_PER_USER, mandates } from ".";

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ mandates: string | null }[]>`SELECT to_regclass('auth.mandates')::text AS mandates`;
    return row?.mandates === "auth.mandates";
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("mandates", () => {
  const suffix = crypto.randomUUID();
  let ownerUserId = "";
  let expiredUserId = "";
  let serviceAccountId = "";
  const createdMandateIds: string[] = [];

  beforeAll(async () => {
    const users = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn, account_expires)
      VALUES
        (${`mandate-owner-${suffix}`}, 'local', 'user', 'Mandate Owner', ${`mandate-owner-${suffix}@example.test`}, 'Mandate', 'Owner', NULL),
        (${`mandate-expired-${suffix}`}, 'local', 'user', 'Mandate Expired', ${`mandate-expired-${suffix}@example.test`}, 'Mandate', 'Expired', now() - interval '1 day')
      RETURNING id, uid
    `;
    ownerUserId = users.find((user) => user.uid.includes("owner"))!.id;
    expiredUserId = users.find((user) => user.uid.includes("expired"))!.id;
    const [serviceAccount] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id, created_by)
      VALUES ('Mandate resource', 'resource_bound', 'mail', 'mailbox', ${suffix}, ${ownerUserId}::uuid)
      RETURNING id
    `;
    serviceAccountId = serviceAccount!.id;
  });

  afterAll(async () => {
    await sql`
        DELETE FROM audit.events
        WHERE target_type = 'mandate' AND target_id = ANY(${toPgTextArray(createdMandateIds)}::text[])
      `;
    await sql`DELETE FROM audit.events WHERE action LIKE 'mandate.%' AND metadata::text LIKE ${`%${suffix}%`}`;
    await sql`DELETE FROM auth.mandates WHERE id = ANY(${toPgTextArray(createdMandateIds)}::uuid[])`;
    if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
    if (ownerUserId && expiredUserId) await sql`DELETE FROM auth.users WHERE id IN (${ownerUserId}::uuid, ${expiredUserId}::uuid)`;
  }, 15_000);

  const interactive = () => ({ kind: "interactive" as const, userId: ownerUserId });
  const exactPolicy = (actions: "deny" | "require_approval" | "preapproved" = "preapproved") => ({
    version: 1 as const,
    apps: ["spaces"],
    operations: ["capability.action.run:event.create-once", "capability.query:space.read"],
    actions,
  });

  test("enforces one mandate per workload and current subjects", async () => {
    const created = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: `unique-${suffix}`,
      policy: exactPolicy(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);

    const duplicate = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: `unique-${suffix}`,
      policy: exactPolicy(),
    });
    expect(duplicate.ok ? null : duplicate.error.code).toBe("CONFLICT");

    const expired = await mandates.create({
      authority: { kind: "admin", userId: ownerUserId },
      subject: { type: "user", id: expiredUserId },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: `expired-${suffix}`,
      policy: exactPolicy(),
    });
    expect(expired.ok ? null : expired.error.code).toBe("FORBIDDEN");
  });

  test("reserves wildcard authority for user-owned Core AI chat tasks", async () => {
    const wildcardPolicy = { version: 1 as const, apps: "*" as const, operations: "*" as const, actions: "require_approval" as const };
    const mail = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "ai.chat-task",
      workloadId: `wildcard-mail-${suffix}`,
      policy: wildcardPolicy,
    });
    expect(mail.ok ? null : mail.error.code).toBe("FORBIDDEN");

    const wrongType = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "core",
      workloadType: "ai.chat_task",
      workloadId: `wildcard-type-${suffix}`,
      policy: wildcardPolicy,
    });
    expect(wrongType.ok ? null : wrongType.error.code).toBe("FORBIDDEN");

    const serviceAccount = await mandates.create({
      authority: { kind: "admin", userId: ownerUserId },
      subject: { type: "service_account", id: serviceAccountId },
      ownerAppId: "core",
      workloadType: "ai.chat-task",
      workloadId: `wildcard-service-${suffix}`,
      policy: wildcardPolicy,
    });
    expect(serviceAccount.ok ? null : serviceAccount.error.code).toBe("FORBIDDEN");
  });

  test("permits workload narrowing but not broadening or resume", async () => {
    const created = await mandates.create({
      authority: { kind: "admin", userId: ownerUserId },
      subject: { type: "service_account", id: serviceAccountId },
      ownerAppId: "mail",
      workloadType: "workflow",
      workloadId: `narrow-${suffix}`,
      policy: exactPolicy(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);
    const workload = { kind: "workload" as const, ownerAppId: "mail" };
    const narrowed = await mandates.updatePolicy({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: workload,
      policy: {
        version: 1,
        apps: ["spaces"],
        operations: ["capability.query:space.read"],
        actions: "deny",
      },
    });
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.data.revision).toBe(created.data.revision + 1);

    const broadened = await mandates.updatePolicy({
      mandateId: narrowed.data.id,
      expectedRevision: narrowed.data.revision,
      authority: workload,
      policy: exactPolicy(),
    });
    expect(broadened.ok).toBe(false);
    const wildcard = await mandates.updatePolicy({
      mandateId: narrowed.data.id,
      expectedRevision: narrowed.data.revision,
      authority: workload,
      policy: { version: 1, apps: "*", operations: "*", actions: "require_approval" },
    });
    expect(wildcard.ok ? null : wildcard.error.code).toBe("FORBIDDEN");

    const paused = await mandates.pause({ mandateId: narrowed.data.id, expectedRevision: narrowed.data.revision, authority: workload });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    const resumed = await mandates.resume({ mandateId: paused.data.id, expectedRevision: paused.data.revision, authority: interactive() });
    expect(resumed.ok).toBe(false);
    const adminResumed = await mandates.resume({
      mandateId: paused.data.id,
      expectedRevision: paused.data.revision,
      authority: { kind: "admin", userId: ownerUserId },
    });
    expect(adminResumed.ok).toBe(true);
    if (!adminResumed.ok) return;
    const adminRevoked = await mandates.revoke({
      mandateId: adminResumed.data.id,
      expectedRevision: adminResumed.data.revision,
      authority: { kind: "admin", userId: ownerUserId },
      reason: "Admin cleanup",
    });
    expect(adminRevoked.ok && adminRevoked.data.revokedByUserId).toBe(ownerUserId);
  });

  test("validates issue authority and makes revocation terminal", async () => {
    const created = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "core",
      workloadType: "ai.chat-task",
      workloadId: `issue-${suffix}`,
      policy: { version: 1, apps: "*", operations: "*", actions: "require_approval" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);

    const denied = await mandates.validateIssueAuthority({
      mandateId: created.data.id,
      ownerAppId: "core",
      targetAppId: "spaces",
      operation: "capability.action.run:event.create",
    });
    expect(denied.ok).toBe(false);
    const allowed = await mandates.validateIssueAuthority({
      mandateId: created.data.id,
      ownerAppId: "core",
      targetAppId: "spaces",
      operation: "capability.action.run:event.create",
      actionApproval: "approved",
      expectedRevision: created.data.revision,
    });
    expect(allowed.ok).toBe(true);

    await sql`UPDATE auth.users SET account_expires = now() - interval '1 minute' WHERE id = ${ownerUserId}::uuid`;
    expect(
      (
        await mandates.validateIssueAuthority({
          mandateId: created.data.id,
          ownerAppId: "core",
          targetAppId: "spaces",
          operation: "capability.query:space.read",
        })
      ).ok,
    ).toBe(false);
    await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${ownerUserId}::uuid`;

    const revoked = await mandates.revoke({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "core" },
      reason: "Task deleted",
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.data.state).toBe("revoked");
    expect(revoked.data.revision).toBe(created.data.revision + 1);
    expect(
      (
        await mandates.resume({
          mandateId: revoked.data.id,
          expectedRevision: revoked.data.revision,
          authority: interactive(),
        })
      ).ok,
    ).toBe(false);
    const replay = await mandates.revoke({
      mandateId: revoked.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "core" },
      reason: "Retry",
    });
    expect(replay.ok && replay.data.revision).toBe(revoked.data.revision);
    expect(
      (
        await mandates.validateIssueAuthority({
          mandateId: revoked.data.id,
          ownerAppId: "core",
          targetAppId: "spaces",
          operation: "capability.query:space.read",
        })
      ).ok,
    ).toBe(false);
  });

  test("durably audits background issuance success and denial without signed material", async () => {
    const created = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "workflow",
      workloadId: `issue-audit-${suffix}`,
      policy: exactPolicy("deny"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);
    const metricsBefore = mandates.metrics.snapshot();

    const issued = await mandates.withIssueAuthority(
      {
        mandateId: created.data.id,
        expectedRevision: created.data.revision,
        ownerAppId: "mail",
        targetAppId: "spaces",
        operation: "capability.query:space.read",
        requestId: `issue-success-${suffix}`,
      },
      async () => ({ token: "signed-material-must-not-enter-audit" }),
    );
    expect(issued.ok).toBe(true);

    let deniedCallbackCalled = false;
    const denied = await mandates.withIssueAuthority(
      {
        mandateId: created.data.id,
        expectedRevision: created.data.revision,
        ownerAppId: "mail",
        targetAppId: "spaces",
        operation: "capability.query:not-allowed",
        requestId: `issue-denied-${suffix}`,
      },
      async () => {
        deniedCallbackCalled = true;
        return { token: "must-not-be-created" };
      },
    );
    expect(denied.ok).toBe(false);
    expect(deniedCallbackCalled).toBe(false);

    const signingFailure = new Error("fixture signer unavailable");
    await expect(
      mandates.withIssueAuthority(
        {
          mandateId: created.data.id,
          expectedRevision: created.data.revision,
          ownerAppId: "mail",
          targetAppId: "spaces",
          operation: "capability.query:space.read",
          requestId: `issue-failed-${suffix}`,
        },
        async () => {
          throw signingFailure;
        },
      ),
    ).rejects.toBe(signingFailure);

    const events = await sql<Array<{ outcome: string; request_id: string | null; metadata: unknown }>>`
      SELECT outcome, request_id, metadata
      FROM audit.events
      WHERE action = 'mandate.issue' AND target_type = 'mandate' AND target_id = ${created.data.id}
      ORDER BY id
    `;
    expect(events.map((event) => ({ outcome: event.outcome, requestId: event.request_id }))).toEqual([
      { outcome: "allowed", requestId: `issue-success-${suffix}` },
      { outcome: "denied", requestId: `issue-denied-${suffix}` },
      { outcome: "failed", requestId: `issue-failed-${suffix}` },
    ]);
    const metadata = events.map((event) => parsePgJsonRecord(event.metadata));
    expect(metadata[0]).toEqual({
      ownerAppId: "mail",
      targetAppId: "spaces",
      operation: "capability.query:space.read",
      revision: created.data.revision,
      requestId: `issue-success-${suffix}`,
      provenance: "background-broker",
    });
    expect(metadata[1]).toEqual({
      ownerAppId: "mail",
      targetAppId: "spaces",
      operation: "capability.query:not-allowed",
      revision: created.data.revision,
      requestId: `issue-denied-${suffix}`,
      provenance: "background-broker",
    });
    expect(metadata[2]).toEqual({
      ownerAppId: "mail",
      targetAppId: "spaces",
      operation: "capability.query:space.read",
      revision: created.data.revision,
      requestId: `issue-failed-${suffix}`,
      provenance: "background-broker",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/signed-material|must-not-be-created|policy|input|token|jwt/i);
    const metricsAfter = mandates.metrics.snapshot();
    expect(metricsAfter.issue_allowed - metricsBefore.issue_allowed).toBe(1);
    expect(metricsAfter.issue_denied_policy - metricsBefore.issue_denied_policy).toBe(1);
    expect(metricsAfter.issue_failed_internal - metricsBefore.issue_failed_internal).toBe(1);

    const rollbackRequestId = `issue-rollback-${suffix}`;
    await expect(
      sql.begin(async (tx) => {
        const result = await mandates.withIssueAuthority(
          {
            mandateId: created.data.id,
            expectedRevision: created.data.revision,
            ownerAppId: "mail",
            targetAppId: "spaces",
            operation: "capability.query:space.read",
            requestId: rollbackRequestId,
          },
          async () => ({ token: "rolled-back-signed-material" }),
          { db: tx },
        );
        expect(result.ok).toBe(true);
        throw new Error("roll back issuance fixture");
      }),
    ).rejects.toThrow("roll back issuance fixture");
    const [rollbackAudit] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM audit.events WHERE action = 'mandate.issue' AND request_id = ${rollbackRequestId}
    `;
    expect(rollbackAudit?.count).toBe(0);
  });

  test("audits lifecycle mutations without policy content and shares caller transactions", async () => {
    const workloadId = `audit-${suffix}`;
    const created = await mandates.create({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "workflow",
      workloadId,
      policy: exactPolicy(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);

    const updated = await mandates.updatePolicy({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: interactive(),
      policy: exactPolicy("require_approval"),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const paused = await mandates.pause({
      mandateId: created.data.id,
      expectedRevision: updated.data.revision,
      authority: { kind: "workload", ownerAppId: "mail" },
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    const resumed = await mandates.resume({
      mandateId: created.data.id,
      expectedRevision: paused.data.revision,
      authority: interactive(),
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const revoked = await mandates.revoke({
      mandateId: created.data.id,
      expectedRevision: resumed.data.revision,
      authority: { kind: "workload", ownerAppId: "mail" },
      reason: "Fixture cleanup",
    });
    expect(revoked.ok).toBe(true);

    const events = await sql<Array<{ action: string; actor_user_id: string | null; metadata: unknown }>>`
      SELECT action, actor_user_id, metadata
      FROM audit.events
      WHERE target_type = 'mandate' AND target_id = ${created.data.id}
      ORDER BY id
    `;
    expect(events.map((event) => event.action)).toEqual([
      "mandate.create",
      "mandate.policy.update",
      "mandate.pause",
      "mandate.resume",
      "mandate.revoke",
    ]);
    expect(events.map((event) => event.actor_user_id)).toEqual([ownerUserId, ownerUserId, null, ownerUserId, null]);
    expect(parsePgJsonRecord(events[2]?.metadata)?.ownerAppId).toBe("mail");
    expect(parsePgJsonRecord(events[4]?.metadata)?.ownerAppId).toBe("mail");
    expect(JSON.stringify(events.map((event) => parsePgJsonRecord(event.metadata)))).not.toMatch(/policy|secret|token|jwt/i);

    const rolledBackWorkloadId = `audit-rollback-${suffix}`;
    let rolledBackMandateId = "";
    await expect(
      sql.begin(async (tx) => {
        const result = await mandates.create(
          {
            authority: interactive(),
            subject: { type: "user", id: ownerUserId },
            ownerAppId: "mail",
            workloadType: "workflow",
            workloadId: rolledBackWorkloadId,
            policy: exactPolicy(),
          },
          { db: tx },
        );
        expect(result.ok).toBe(true);
        if (result.ok) rolledBackMandateId = result.data.id;
        throw new Error("roll back fixture");
      }),
    ).rejects.toThrow("roll back fixture");
    const [rolledBack] = await sql<{ mandates: number; events: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM auth.mandates WHERE id = ${rolledBackMandateId}::uuid) AS mandates,
        (SELECT COUNT(*)::int FROM audit.events WHERE target_type = 'mandate' AND target_id = ${rolledBackMandateId}) AS events
    `;
    expect(rolledBack).toEqual({ mandates: 0, events: 0 });
  });

  test("rejects stale revisions and disabled service-account subjects", async () => {
    const workloadId = `revision-${suffix}`;
    const created = await mandates.create({
      authority: { kind: "admin", userId: ownerUserId },
      subject: { type: "service_account", id: serviceAccountId },
      ownerAppId: "mail",
      workloadType: "workflow",
      workloadId,
      policy: exactPolicy("deny"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);
    const pauses = await Promise.all([
      mandates.pause({
        mandateId: created.data.id,
        expectedRevision: created.data.revision,
        authority: { kind: "workload", ownerAppId: "mail" },
      }),
      mandates.pause({
        mandateId: created.data.id,
        expectedRevision: created.data.revision,
        authority: { kind: "workload", ownerAppId: "mail" },
      }),
    ]);
    expect(pauses.filter((result) => result.ok)).toHaveLength(1);
    expect(pauses.filter((result) => !result.ok && result.error.code === "CONFLICT")).toHaveLength(1);
    const stale = await mandates.updatePolicy({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "mail" },
      policy: exactPolicy("deny"),
    });
    expect(stale.ok ? null : stale.error.code).toBe("CONFLICT");

    const paused = pauses.find((result) => result.ok);
    if (!paused?.ok) return;
    const resumed = await mandates.resume({
      mandateId: created.data.id,
      expectedRevision: paused.data.revision,
      authority: { kind: "admin", userId: ownerUserId },
    });
    expect(resumed.ok).toBe(true);

    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${serviceAccountId}::uuid`;
    const unavailable = await mandates.validateIssueAuthority({
      mandateId: created.data.id,
      ownerAppId: "mail",
      targetAppId: "spaces",
      operation: "capability.query:space.read",
    });
    expect(unavailable.ok).toBe(false);
  });

  test("keeps remote mandates unusable until their authenticated owner confirms persistence", async () => {
    const created = await mandates.createPending({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "remote.job",
      workloadId: `pending-${suffix}`,
      policy: exactPolicy(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);
    expect(created.data.confirmedAt).toBeNull();
    expect(created.data.confirmationDeadline).not.toBeNull();

    const beforeConfirmation = await mandates.validateIssueAuthority({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      ownerAppId: "mail",
      targetAppId: "spaces",
      operation: "capability.query:space.read",
    });
    expect(beforeConfirmation.ok).toBe(false);

    const wrongOwner = await mandates.confirm({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "oauth" },
    });
    expect(wrongOwner.ok ? null : wrongOwner.error.code).toBe("FORBIDDEN");

    const confirmed = await mandates.confirm({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "mail" },
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.confirmedAt).not.toBeNull();
    expect(confirmed.data.confirmationDeadline).toBeNull();
    expect(confirmed.data.revision).toBe(created.data.revision);
    expect(
      (
        await mandates.validateIssueAuthority({
          mandateId: created.data.id,
          expectedRevision: created.data.revision,
          ownerAppId: "mail",
          targetAppId: "spaces",
          operation: "capability.query:space.read",
        })
      ).ok,
    ).toBe(true);
  });

  test("pending registrations cannot squat a confirmed workload and concurrent confirmation has one winner", async () => {
    const input = {
      authority: interactive(),
      subject: { type: "user" as const, id: ownerUserId },
      ownerAppId: "external",
      workloadType: "remote.job",
      workloadId: `squat-${suffix}`,
      policy: exactPolicy(),
    };
    const pending = await mandates.createPending(input);
    const legitimate = await mandates.create(input);
    expect(pending.ok).toBe(true);
    expect(legitimate.ok).toBe(true);
    if (!pending.ok || !legitimate.ok) throw new Error("Mandate fixture creation failed");
    createdMandateIds.push(pending.data.id, legitimate.data.id);
    const conflict = await mandates.confirm({
      mandateId: pending.data.id,
      expectedRevision: 1,
      authority: { kind: "workload", ownerAppId: "external" },
    });
    expect(conflict.ok ? null : conflict.error.code).toBe("CONFLICT");
    expect((await mandates.get(pending.data.id))?.confirmedAt).toBeNull();

    const candidates = await Promise.all([1, 2].map(() => mandates.createPending({ ...input, workloadId: `confirm-race-${suffix}` })));
    const ids = candidates.map((candidate) => {
      if (!candidate.ok) throw new Error("Pending fixture failed");
      createdMandateIds.push(candidate.data.id);
      return candidate.data.id;
    });
    const confirmed = await Promise.all(
      ids.map((mandateId) => mandates.confirm({ mandateId, expectedRevision: 1, authority: { kind: "workload", ownerAppId: "external" } })),
    );
    expect(confirmed.filter((result) => result.ok)).toHaveLength(1);
    expect(confirmed.filter((result) => !result.ok && result.error.code === "CONFLICT")).toHaveLength(1);
  });

  test("serializes the pending quota across concurrent creators and frees expired capacity", async () => {
    // Keep the quota fixture independent from other tests' pending registrations.
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`pending-quota-${suffix}`}, 'local', 'user', 'Pending quota') RETURNING id
    `;
    if (!creator) throw new Error("Missing quota fixture user");
    const input = {
      authority: { kind: "interactive" as const, userId: creator.id },
      subject: { type: "user" as const, id: creator.id },
      ownerAppId: "external",
      workloadType: "remote.job",
      policy: exactPolicy(),
    };
    try {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO auth.mandates (subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy, created_by_user_id, confirmed_at, confirmation_deadline)
        SELECT 'user', ${creator.id}::uuid, 'external', 'remote.job', ${`quota-${suffix}-`} || slot::text,
          ${exactPolicy()}::jsonb, ${creator.id}::uuid, NULL, now() + interval '15 minutes'
        FROM generate_series(1, ${MANDATE_MAX_PENDING_PER_USER - 1}) slot
        RETURNING id
      `;
      createdMandateIds.push(...rows.map((row) => row.id));
      const attempts = await Promise.all(
        [1, 2].map((slot) => mandates.createPending({ ...input, workloadId: `quota-race-${suffix}-${slot}` })),
      );
      for (const result of attempts) if (result.ok) createdMandateIds.push(result.data.id);
      expect(attempts.filter((result) => result.ok)).toHaveLength(1);
      expect(attempts.filter((result) => !result.ok && result.error.code === "CONFLICT")).toHaveLength(1);
      await sql`UPDATE auth.mandates SET created_at = now() - interval '20 minutes', confirmation_deadline = now() - interval '1 minute' WHERE id = ${rows[0]!.id}::uuid`;
      const next = await mandates.createPending({ ...input, workloadId: `quota-after-expiry-${suffix}` });
      expect(next.ok).toBe(true);
      if (next.ok) createdMandateIds.push(next.data.id);
    } finally {
      await sql`DELETE FROM audit.events WHERE actor_user_id = ${creator.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${creator.id}::uuid`;
    }
  });

  test("lists bounded scopes and terminally reconciles stale unconfirmed mandates", async () => {
    const created = await mandates.createPending({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "remote.job",
      workloadId: `orphan-${suffix}`,
      policy: exactPolicy(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdMandateIds.push(created.data.id);

    const userPage = await mandates.list({
      scope: { kind: "user", userId: ownerUserId },
      pagination: { page: 1, perPage: 1 },
      filter: { ownerAppId: "mail" },
    });
    expect(userPage.items).toHaveLength(1);
    expect(userPage.perPage).toBe(1);
    const boundedAdminPage = await mandates.list({ scope: { kind: "admin" }, pagination: { page: 1, perPage: 10_000 } });
    expect(boundedAdminPage.perPage).toBe(100);
    const otherOwner = await mandates.list({ scope: { kind: "owner", ownerAppId: "oauth" } });
    expect(otherOwner.items.some((item) => item.id === created.data.id)).toBe(false);

    const paused = await mandates.pause({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "workload", ownerAppId: "mail" },
    });
    expect(paused.ok).toBe(true);

    await sql`
      UPDATE auth.mandates
      SET created_at = now() - interval '20 minutes', confirmation_deadline = now() - interval '1 minute'
      WHERE id = ${created.data.id}::uuid
    `;
    expect(await mandates.reconcileUnconfirmed({ limit: 1 })).toBe(1);
    expect(await mandates.reconcileUnconfirmed({ limit: 1 })).toBe(0);
    const reconciled = await mandates.get(created.data.id);
    expect(reconciled).toMatchObject({ state: "revoked", revokeReason: "Workload registration was not confirmed" });

    const retried = await mandates.createPending({
      authority: interactive(),
      subject: { type: "user", id: ownerUserId },
      ownerAppId: "mail",
      workloadType: "remote.job",
      workloadId: `orphan-${suffix}`,
      policy: exactPolicy(),
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      createdMandateIds.push(retried.data.id);
      expect(retried.data.id).not.toBe(created.data.id);
    }
  });
});
