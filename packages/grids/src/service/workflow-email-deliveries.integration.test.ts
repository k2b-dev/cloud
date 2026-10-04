import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  finishWorkflowEmailDeliveryIntent,
  getOrCreateWorkflowEmailDeliveryIntent,
  getWorkflowEmailDeliveryIntent,
  type WorkflowEmailDeliveryIntent,
} from "./workflow-email-deliveries";
import { deleteTestWorkflowScope, insertTestWorkflow } from "./workflow-test-fixture";

type Fixture = {
  baseId: string;
  workflowId: string;
  runId: string;
  stepKey: string;
  templateId: string;
};

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const insertFixture = async (): Promise<Fixture> => {
  const baseId = testUuid();
  const workflowId = testUuid();
  const runId = testUuid();
  const stepKey = "steps.0";
  const templateId = testUuid();

  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId()}, 'Email delivery')`;
  await insertTestWorkflow({ id: workflowId, shortId: testShortId(), baseId: baseId, name: "Notify", source: "steps: []" });
  await sql`
    INSERT INTO grids.email_templates (id, short_id, base_id, name, subject, html)
    VALUES (${templateId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Notice', 'Subject', '<p>Private</p>')
  `;
  return { baseId, workflowId, runId, stepKey, templateId };
};

type IntentInput = ReturnType<typeof intentInput>;

/**
 * Creates `first` in an open transaction, starts `second` on another
 * connection, and commits only once the database reports `second` waiting
 * for that transaction. This forces `second` to meet the uncommitted row, but
 * not the interleaving in which both speculative checks pass before either
 * insert lands; the parallel deduplication test covers that one statistically.
 */
const createWhileInFlight = async (first: IntentInput, second: IntentInput) => {
  const started = Promise.withResolvers<number>();
  let racing: Promise<WorkflowEmailDeliveryIntent> | undefined;
  try {
    const winner = await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      const [owner] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!owner) throw new Error("Missing winner connection");
      const created = await getOrCreateWorkflowEmailDeliveryIntent(first, tx);
      racing = sql.begin(async (loser) => {
        await loser`SET LOCAL lock_timeout = '10s'`;
        const [connection] = await loser<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (!connection) throw new Error("Missing racing connection");
        started.resolve(connection.pid);
        return getOrCreateWorkflowEmailDeliveryIntent(second, loser);
      });
      racing.catch((error) => started.reject(error));
      const loserPid = await started.promise;
      const deadline = Date.now() + 5_000;
      while (true) {
        const [waiting] = await sql<Array<{ blocked: boolean }>>`SELECT ${owner.pid} = ANY(pg_blocking_pids(${loserPid})) AS blocked`;
        if (waiting?.blocked) break;
        if (Date.now() >= deadline) throw new Error("The racing create did not wait for the in-flight intent");
        await Bun.sleep(20);
      }
      return created;
    });
    if (!racing) throw new Error("The racing create never started");
    return { winner, racing };
  } catch (error) {
    await racing?.catch(() => undefined);
    throw error;
  }
};

const intentInput = (fixture: Fixture, overrides: Partial<{ recipientIndex: number; idempotencyKey: string; subject: string }> = {}) => ({
  baseId: fixture.baseId,
  workflowId: fixture.workflowId,
  workflowRunId: fixture.runId,
  workflowStepKey: fixture.stepKey,
  templateId: fixture.templateId,
  recipientIndex: overrides.recipientIndex ?? 1,
  recipientKind: "email" as const,
  recipientValue: "private@example.test",
  recipientSummary: "p…@example.test",
  idempotencyKey: overrides.idempotencyKey ?? `delivery-${fixture.runId}`,
  subject: overrides.subject ?? "Private subject",
  renderedHtml: "<p>Private body</p>",
});

describe("workflow email delivery intents integration", () => {
  postgresTest("replays identical intent creation and rejects conflicting reuse", async () => {
    const fixture = await insertFixture();
    try {
      const input = intentInput(fixture);
      const created = await getOrCreateWorkflowEmailDeliveryIntent(input);
      const replayed = await getOrCreateWorkflowEmailDeliveryIntent(input);
      expect(replayed).toEqual(created);
      expect(created).toMatchObject({ status: "pending", recipientValue: "private@example.test", renderedHtml: "<p>Private body</p>" });
      expect(await getWorkflowEmailDeliveryIntent(fixture.runId, fixture.stepKey, 1)).toEqual(created);
      expect(await getWorkflowEmailDeliveryIntent(fixture.runId, fixture.stepKey, 2)).toBeNull();

      await expect(getOrCreateWorkflowEmailDeliveryIntent(intentInput(fixture, { subject: "Changed subject" }))).rejects.toThrow(
        "does not match the interrupted step",
      );
      await expect(getOrCreateWorkflowEmailDeliveryIntent(intentInput(fixture, { recipientIndex: 2 }))).rejects.toThrow(
        "does not match the interrupted step",
      );
      await expect(getOrCreateWorkflowEmailDeliveryIntent({ ...input, workflowStepKey: "steps.1" })).rejects.toThrow(
        "does not match the interrupted step",
      );
      expect(await getWorkflowEmailDeliveryIntent(fixture.runId, fixture.stepKey, 2)).toBeNull();
    } finally {
      await deleteTestWorkflowScope(fixture.baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("allows only one terminal transition and scrubs rendered recipient data", async () => {
    const fixture = await insertFixture();
    try {
      const created = await getOrCreateWorkflowEmailDeliveryIntent(intentInput(fixture));
      const finished = await finishWorkflowEmailDeliveryIntent(created.id, {
        notificationId: null,
        providerStatus: "accepted",
        status: "sent",
      });
      expect(finished.transitioned).toBe(true);
      expect(finished.delivery).toMatchObject({ status: "sent", recipientValue: null, renderedHtml: null, providerStatus: "accepted" });

      const repeated = await finishWorkflowEmailDeliveryIntent(created.id, {
        notificationId: null,
        providerStatus: "rejected",
        status: "failed",
        error: "must not replace terminal state",
      });
      expect(repeated.transitioned).toBe(false);
      expect(repeated.delivery).toMatchObject({ status: "sent", providerStatus: "accepted", error: null });

      const [stored] = await sql<Array<{ recipient_value: string | null; rendered_html: string | null }>>`
        SELECT recipient_value, rendered_html FROM grids.workflow_email_deliveries WHERE id = ${created.id}::uuid
      `;
      expect(stored).toEqual({ recipient_value: null, rendered_html: null });
      await expect(
        finishWorkflowEmailDeliveryIntent(testUuid(), { notificationId: null, providerStatus: "missing", status: "failed" }),
      ).rejects.toThrow("not found");
    } finally {
      await deleteTestWorkflowScope(fixture.baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  // Passes with a targeted ON CONFLICT too: the loser waits on the key and
  // then does nothing. The other-key test below pins the full arbiter set.
  postgresTest("waits for an in-flight identical create and returns its intent", async () => {
    const fixture = await insertFixture();
    try {
      const input = intentInput(fixture);
      const { winner, racing } = await createWhileInFlight(input, input);
      expect(await racing).toEqual(winner);
      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.workflow_email_deliveries WHERE workflow_run_id = ${fixture.runId}::uuid
      `;
      expect(count).toBe(1);
    } finally {
      await deleteTestWorkflowScope(fixture.baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  // With ON CONFLICT on the key alone, the loser fails with a unique
  // violation on the run, step, and recipient index instead of a conflict.
  postgresTest("rejects a concurrent create for the same recipient under another key as a conflict", async () => {
    const fixture = await insertFixture();
    try {
      const { winner, racing } = await createWhileInFlight(
        intentInput(fixture),
        intentInput(fixture, { idempotencyKey: `other-${fixture.runId}` }),
      );
      await expect(racing).rejects.toMatchObject({ status: 409, message: expect.stringContaining("does not match the interrupted step") });
      expect(await getWorkflowEmailDeliveryIntent(fixture.runId, fixture.stepKey, 1)).toEqual(winner);
    } finally {
      await deleteTestWorkflowScope(fixture.baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("deduplicates concurrent creates by idempotency key", async () => {
    const fixture = await insertFixture();
    try {
      const input = intentInput(fixture);
      const deliveries = await Promise.all([getOrCreateWorkflowEmailDeliveryIntent(input), getOrCreateWorkflowEmailDeliveryIntent(input)]);
      expect(deliveries[0]?.id).toBe(deliveries[1]?.id);
      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.workflow_email_deliveries WHERE idempotency_key = ${input.idempotencyKey}
      `;
      expect(count).toBe(1);
    } finally {
      await deleteTestWorkflowScope(fixture.baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });
});
