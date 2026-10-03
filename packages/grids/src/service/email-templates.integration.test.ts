import { expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { create, get, listDependenciesForBase, remove, update } from "./email-templates";
import { createWorkflow, removeWorkflow } from "./workflow-definitions";
import { deleteTestWorkflowScope } from "./workflow-test-fixture";

const uuid = () => Bun.randomUUIDv7();

postgresTest("email templates persist and update nested preview sample data", async () => {
  await migrate();
  const baseId = uuid();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId()}, 'Email template sample data')
  `;

  try {
    const created = await create(
      baseId,
      {
        name: "Loan agreement ready",
        subject: "Loan {{ data.loanNumber }}",
        html: "<p>Hello {{ data.requester.name }}</p>",
        sampleData: {
          loanNumber: "LOAN-42",
          requester: { name: "Alex Morgan" },
        },
      },
      null,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    expect((await get(created.data.id))?.sampleData).toEqual({
      loanNumber: "LOAN-42",
      requester: { name: "Alex Morgan" },
    });

    const updated = await update(created.data.id, { sampleData: { requester: { name: "Grace Hopper" } } }, null);
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;
    expect(updated.data.sampleData).toEqual({ requester: { name: "Grace Hopper" } });
  } finally {
    await deleteTestWorkflowScope(baseId);
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("email templates report workflow dependencies and reject deletion while in use", async () => {
  await migrate();
  const baseId = uuid();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId()}, 'Email template dependency test')
  `;

  try {
    const template = await create(
      baseId,
      {
        name: "Ready notice",
        subject: "Ready",
        html: "<p>Ready</p>",
      },
      null,
    );
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const workflow = await createWorkflow(
      baseId,
      {
        name: "Send ready notice",
        source: `steps:
  - sendEmail:
      template: Ready notice
      to:
        - email: test@example.com`,
      },
      null,
    );
    expect(workflow.ok).toBe(true);
    if (!workflow.ok) return;

    expect(await listDependenciesForBase(baseId)).toEqual({
      [template.data.id]: [
        {
          workflowId: workflow.data.id,
          workflowShortId: workflow.data.shortId,
          workflowName: workflow.data.name,
        },
      ],
    });
    const blocked = await remove(template.data.id, null);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.status).toBe(409);

    expect((await removeWorkflow(workflow.data.id, null)).ok).toBe(true);
    expect((await remove(template.data.id, null)).ok).toBe(true);
  } finally {
    await deleteTestWorkflowScope(baseId);
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});
