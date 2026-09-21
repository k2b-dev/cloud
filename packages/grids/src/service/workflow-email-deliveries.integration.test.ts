import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  finishWorkflowEmailDeliveryIntent,
  getOrCreateWorkflowEmailDeliveryIntent,
  getWorkflowEmailDeliveryIntent,
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

  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Email delivery')`;
  await insertTestWorkflow({ id: workflowId, shortId: testShortId("W"), baseId: baseId, name: "Notify", source: "steps: []" });
  await sql`
    INSERT INTO grids.email_templates (id, short_id, base_id, name, subject, html)
    VALUES (${templateId}::uuid, ${testShortId("E")}, ${baseId}::uuid, 'Notice', 'Subject', '<p>Private</p>')
  `;
  return { baseId, workflowId, runId, stepKey, templateId };
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
