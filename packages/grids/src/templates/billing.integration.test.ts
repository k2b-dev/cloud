import { beforeAll, expect } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { createWorkflowRun } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { objectListRecordInputValues } from "../field-types/object-list";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { getBaseNavigation } from "../service/base-navigation";
import { listByTable } from "../service/fields";
import { type FormSubmission, submitForm } from "../service/form-submission";
import { get as getForm } from "../service/forms";
import { buildTrustedGqlResolverContext } from "../service/gql-resolver-context";
import { create, get, update } from "../service/records";
import { instantiateDefinition } from "../service/templates";
import { GRIDS_APP_ID, gridsAuthorizationSnapshot } from "../service/workflow-runs";
import { runGridsWorkflowRun } from "../service/workflow-runtime";
import { deleteTestWorkflowScope, publishTestWorkflowVersion } from "../service/workflow-test-fixture";
import { createBillingTemplate } from "./billing";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

for (const locale of ["en", "de"]) {
  for (const withSampleData of [false, true]) {
    postgresTest(
      `billing installs with valid published forms, workflows and app in ${locale} (samples: ${withSampleData})`,
      async () => {
        const started = performance.now();
        const checkpoint = (phase: string) =>
          console.info(`[billing install ${locale}/${withSampleData}] ${phase}: ${Math.round(performance.now() - started)}ms`);
        const definition = createBillingTemplate(locale);
        const result = await instantiateDefinition(definition, { withSampleData }, null, locale);
        if (!result.ok) throw new Error(result.error.message);
        checkpoint("installed");
        const baseId = result.data.id;
        try {
          const tables = await sql`SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid`;
          expect(tables).toHaveLength(4);
          const [records] =
            await sql`SELECT count(*)::int AS count FROM grids.records WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
          // Required issuer setup plus one partner and two draft bills; no
          // commission collection records are needed for direct positions.
          expect(records.count).toBe(withSampleData ? 4 : 1);
          const apps = await sql`SELECT id, published_definition FROM grids.custom_apps
            WHERE base_id = ${baseId}::uuid AND published_definition IS NOT NULL`;
          expect(apps).toHaveLength(1);
          expect(apps[0].published_definition.pages).toHaveLength(11);
          const workflows = await sql`SELECT w.id FROM grids.workflow_profile p
            JOIN workflows.workflow w ON w.id = p.id
            WHERE p.base_id = ${baseId}::uuid AND w.active_version_id IS NOT NULL`;
          expect(workflows).toHaveLength(7);
          const navigation = await getBaseNavigation(baseId);
          expect(navigation?.groups).toHaveLength(3);
          expect(navigation?.revision).toBe(1);
          const [issued] = await sql`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${baseId}::uuid`;
          expect(issued.count).toBe(0);
          const [finalized] = await sql`SELECT count(*)::int AS count FROM grids.records
        WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid) AND finalized_at IS NOT NULL`;
          expect(finalized.count).toBe(0);
          for (const key of ["settings", "bills"]) {
            const spec = definition.tables.find((entry) => entry.key === key)!;
            const [installedTable] = await sql`SELECT id::text FROM grids.tables WHERE base_id = ${baseId}::uuid AND name = ${spec.name}`;
            const expectedField = spec.fields.find((entry) => entry.key === (key === "settings" ? "ready" : "gross"))!;
            const [installedField] =
              await sql`SELECT id::text FROM grids.fields WHERE table_id = ${installedTable.id}::uuid AND name = ${expectedField.name}`;
            const seeded = await sql`SELECT id::text FROM grids.records WHERE table_id = ${installedTable.id}::uuid`;
            expect(seeded).toHaveLength(key === "settings" ? 1 : withSampleData ? 2 : 0);
            for (const seed of seeded) {
              const current = await get(installedTable.id, seed.id);
              expect(current?.data[installedField.id]).toBe(key === "settings" ? false : "22.6");
            }
            if (key === "bills" && withSampleData) {
              const detailsSpec = definition.forms!.find((entry) => entry.key === "edit_draft")!;
              const [row] =
                await sql`SELECT id::text FROM grids.forms WHERE table_id = ${installedTable.id}::uuid AND name = ${detailsSpec.name}`;
              const detailsForm = await getForm(row.id);
              const installedFields = await listByTable(installedTable.id);
              const kindId = installedFields.find((field) => field.name === spec.fields.find((field) => field.key === "kind")!.name)!.id;
              const notesId = installedFields.find((field) => field.name === spec.fields.find((field) => field.key === "notes")!.name)!.id;
              const [invoice] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${installedTable.id}::uuid
            AND data -> ${kindId} = '["invoice"]'::jsonb`;
              const original = await get(installedTable.id, invoice.id);
              if (!detailsForm || !original) throw new Error("Missing details form or example draft");
              const inputIds = detailsForm.config.fields.filter((entry) => entry.kind === "user_input").map((entry) => entry.fieldId);
              const editable = objectListRecordInputValues(installedFields, original.data);
              const submitted = Object.fromEntries(inputIds.filter((id) => editable[id] !== undefined).map((id) => [id, editable[id]]));
              submitted[notesId] = "Optional note saved with the draft";
              const saved = await submitForm({
                form: detailsForm,
                actorId: null,
                dateConfig: { locale },
                record: { id: original.id, version: original.version },
                submission: { idempotencyKey: testUuid(), data: submitted, inlineCreates: {} },
              });
              expect(saved.ok, JSON.stringify(saved)).toBe(true);
              const changed = await get(installedTable.id, original.id);
              expect(changed?.data).toEqual({ ...original.data, [notesId]: submitted[notesId] });
              for (const formKey of ["new_invoice", "new_self_billing"]) {
                const formSpec = definition.forms!.find((entry) => entry.key === formKey)!;
                const [formRow] =
                  await sql`SELECT id::text FROM grids.forms WHERE table_id = ${installedTable.id}::uuid AND name = ${formSpec.name}`;
                const creationForm = await getForm(formRow.id);
                if (!creationForm) throw new Error("Missing creation form");
                expect(creationForm.config.computedFields).toHaveLength(3);
                // Only send fields the actual form exposes; hidden required fields
                // must not be rescued by copying the entire sample record.
                const data = Object.fromEntries(
                  creationForm.config.fields
                    .filter((entry) => entry.kind === "user_input" && editable[entry.fieldId] !== undefined)
                    .map((entry) => [entry.fieldId, editable[entry.fieldId]]),
                );
                const created = await submitForm({
                  form: creationForm,
                  actorId: null,
                  dateConfig: { locale },
                  submission: { idempotencyKey: testUuid(), data, inlineCreates: {} },
                });
                expect(created.ok, JSON.stringify(created)).toBe(true);
                if (!created.ok) throw new Error(created.error.message);
                const [draft] = await sql`SELECT finalized_at FROM grids.records WHERE id = ${created.data.recordId}::uuid`;
                expect(draft.finalized_at).toBeNull();
                const partnerId = installedFields.find(
                  (field) => field.name === spec.fields.find((field) => field.key === "party")!.name,
                )!.id;
                const partnerEntry = creationForm.config.fields.find((entry) => entry.fieldId === partnerId);
                if (!partnerEntry || partnerEntry.kind !== "user_input") throw new Error("Missing partner input");
                if (formKey === "new_self_billing") {
                  expect(partnerEntry.inlineCreate?.enabled ?? false).toBe(false);
                  continue;
                }
                expect(partnerEntry.inlineCreate?.enabled).toBe(true);
                if (!partnerEntry.inlineCreate?.enabled) throw new Error("New invoice must offer inline partners");
                const inlineFields = partnerEntry.inlineCreate.fields;
                if (!inlineFields?.length) throw new Error("New invoice must declare its inline partner fields");
                const partySpec = definition.tables.find((table) => table.key === "parties")!;
                const [partyTable] =
                  await sql`SELECT id::text FROM grids.tables WHERE base_id = ${baseId}::uuid AND name = ${partySpec.name}`;
                const partyFields = await listByTable(partyTable.id);
                const [sampleParty] = await sql<
                  { data: Record<string, unknown> }[]
                >`SELECT data FROM grids.records WHERE table_id = ${partyTable.id}::uuid LIMIT 1`;
                if (!sampleParty) throw new Error("Missing installed sample partner");
                const partyName = partyFields.find((field) => field.presentable)!;
                const inlineData = Object.fromEntries(
                  inlineFields.map((entry) => {
                    const field = partyFields.find((field) => field.id === entry.fieldId);
                    if (!field) throw new Error("Inline configuration refers to an unknown partner field");
                    const value = field.id === partyName.id ? `Inline partner ${locale}` : (sampleParty.data[field.id] ?? null);
                    if (entry.required ?? field.required) expect(value).not.toBeNull();
                    return [field.id, value];
                  }),
                );
                const [before] = await sql`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${partyTable.id}::uuid`;
                const submission: FormSubmission = {
                  idempotencyKey: testUuid(),
                  data: { ...data, [partnerId]: ["tmp_billing_partner"] },
                  inlineCreates: { [partnerId]: [{ tempId: "tmp_billing_partner", data: inlineData }] },
                };
                const input = { form: creationForm, actorId: null, dateConfig: { locale }, submission };
                const inlineCreated = await submitForm(input);
                if (!inlineCreated.ok) throw new Error(inlineCreated.error.message);
                expect(await submitForm(input)).toEqual(inlineCreated);
                const linked = await sql<{ id: string; data: Record<string, unknown> }[]>`
                  SELECT r.id::text, r.data FROM grids.record_links l JOIN grids.records r ON r.id = l.to_record_id
                  WHERE l.from_record_id = ${inlineCreated.data.recordId}::uuid AND l.from_field_id = ${partnerId}::uuid`;
                expect(linked).toHaveLength(1);
                // Empty optional values are absent in canonical record data.
                for (const [id, value] of Object.entries(inlineData)) expect(linked[0]!.data[id] ?? null).toEqual(value);
                expect(linked[0]!.id).not.toBe("tmp_billing_partner");
                const [after] = await sql`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${partyTable.id}::uuid`;
                expect(after.count).toBe(before.count + 1);
                const inlineInvoice = await get(installedTable.id, inlineCreated.data.recordId);
                for (const key of ["net", "tax", "gross"]) {
                  const amountId = installedFields.find((field) => field.name === spec.fields.find((field) => field.key === key)!.name)!.id;
                  expect(inlineInvoice?.data[amountId]).toBe(original.data[amountId]);
                }
                expect(inlineInvoice?.finalizedAt).toBeNull();
              }
            }
          }
        } finally {
          checkpoint("checked; cleaning fixture");
          await deleteTestWorkflowScope(baseId);
          await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
          await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
          await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
          await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
          await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
          checkpoint("cleaned");
        }
      },
      // Sample cases include install, edit, two creates and an inline-create
      // replay. Use the full-journey budget, not the empty-install budget.
      withSampleData ? 180_000 : 30_000,
    );
  }
}

for (const valid of [false, true]) {
  postgresTest(
    `billing authored invoice freezes party lookups ${valid ? "after valid profile input" : "only if profile validation succeeds"}`,
    async () => {
      const definition = createBillingTemplate("en");
      const installed = await instantiateDefinition(definition, { withSampleData: false }, null, "en");
      if (!installed.ok) throw new Error(installed.error.message);
      const baseId = installed.data.id;
      const actorId = testUuid();
      try {
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Billing test', 'Billing', 'Test')`;
        const [access] = await sql`INSERT INTO auth.access (user_id, permission) VALUES (${actorId}::uuid, 'write') RETURNING id`;
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
        const tables = await sql<
          Array<{ id: string; name: string }>
        >`SELECT id::text, name FROM grids.tables WHERE base_id = ${baseId}::uuid`;
        const resolve = async (key: string) => {
          const spec = definition.tables.find((entry) => entry.key === key)!;
          const table = tables.find((entry) => entry.name === spec.name)!;
          const fields = await sql<
            Array<{ id: string; name: string }>
          >`SELECT id::text, name FROM grids.fields WHERE table_id = ${table.id}::uuid`;
          const ids = Object.fromEntries(
            spec.fields.map((entry) => [entry.key, fields.find((candidate) => candidate.name === entry.name)!.id]),
          );
          return {
            id: table.id,
            ids,
            values: (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [ids[key]!, value])),
          };
        };
        const settings = await resolve("settings");
        const parties = await resolve("parties");
        const bills = await resolve("bills");
        const [issuer] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${settings.id}::uuid`;
        const common = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
        const setup = await update(
          settings.id,
          issuer.id,
          settings.values({
            ...common,
            name: "Original issuer",
            vat_id: "DE123456789",
            ready: true,
            iban: valid ? common.iban : "INVALID",
          }),
          actorId,
          "workflow",
        );
        if (!setup.ok) throw new Error(setup.error.message);
        const partner = await create(
          parties.id,
          parties.values({ ...common, name: "Original buyer", vat_id: "DE987654321" }),
          actorId,
          "workflow",
        );
        if (!partner.ok) throw new Error(partner.error.message);
        const created = await create(
          bills.id,
          bills.values({
            kind: ["invoice"],
            settings: [issuer.id],
            party: [partner.data.id],
            invoice_date: "2026-09-14",
            service_date: "2026-09-01",
            due_date: "2026-09-28",
            buyer_reference: "Order 42",
            positions: [{ Label1: "Consulting", Unit01: ["C62"], Qty001: "1.25", Price1: "19.99", Vat001: ["vat007"] }],
          }),
          actorId,
          "workflow",
        );
        if (!created.ok) throw new Error(created.error.message);
        const [documentTemplate] = await sql`SELECT source FROM grids.document_templates WHERE table_id = ${bills.id}::uuid`;
        const parsed = parseGridsQueryDsl(documentTemplate.source.replace("{{ record.id }}", created.data.shortId));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed));
        const queryContext = await buildTrustedGqlResolverContext({
          baseId,
          currentTableId: bills.id,
          ast: parsed.ast,
          purpose: "document-template-render",
        });
        const resolved = resolveDslQueryToQueryPlan(parsed.ast, queryContext);
        if (!resolved.ok) throw new Error(JSON.stringify(resolved));
        const [workflow] = await sql<Array<{ id: string; source: string; plan: WorkflowBoundPlan }>>`
        SELECT w.id::text, v.source, v.plan FROM grids.workflow_profile p
        JOIN workflows.workflow w ON w.id = p.id JOIN workflows.version v ON v.id = w.active_version_id
        WHERE p.base_id = ${baseId}::uuid AND w.name = 'Issue invoice'`;
        if (!workflow) throw new Error("Missing authored invoice workflow");
        // Execute the real published atomic step and Liquid/profile validation,
        // but keep external PDF rendering out of this transaction acceptance test.
        const boundary = workflow.plan.steps.findIndex((step) => step.kind === "action" && step.action === "generateDocument");
        // Finalized-record lookup and the conditional atomic finalization now
        // precede document generation, so the same action also supports retry.
        expect(boundary).toBe(2);
        const revision = await publishTestWorkflowVersion(workflow.id, workflow.source, {
          ...workflow.plan,
          steps: workflow.plan.steps.slice(0, boundary),
        });
        const [version] =
          await sql`SELECT id::text FROM workflows.version WHERE workflow_id = ${workflow.id}::uuid AND revision = ${revision}`;
        const inputs: Record<string, WorkflowJsonValue> = { bill: { kind: "record", tableId: bills.id, recordId: created.data.id } };
        const runId = await createWorkflowRun({
          appId: GRIDS_APP_ID,
          scopeId: baseId,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          mode: "execute",
          inputs,
          context: {},
          authorization: gridsAuthorizationSnapshot({ userId: actorId, groupIds: [], serviceAccountId: null }, { kind: "workflow" }, null),
          idempotencyKey: testUuid(),
          occurredAt: new Date(),
        });
        await sql`INSERT INTO grids.workflow_run_profile (run_id, short_id, base_id, workflow_id, channel, actor_user_id, request_fingerprint)
        VALUES (${runId}::uuid, ${testShortId("R")}, ${baseId}::uuid, ${workflow.id}::uuid, 'api', ${actorId}::uuid, ${runId})`;
        let terminal = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          await runGridsWorkflowRun(runId);
          const [run] = await sql`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
          if (["failed", "succeeded", "needs_attention", "canceled"].includes(run.state)) {
            expect(run.state, JSON.stringify(run.error)).toBe(valid ? "succeeded" : "failed");
            if (!valid) {
              expect(run.error?.code).toBe("DOCUMENT_INPUT_INVALID");
              expect(JSON.stringify(run.error)).toContain("IBAN");
            }
            terminal = true;
            break;
          }
        }
        expect(terminal).toBe(true);
        const [stored] = await sql`SELECT finalized_at, version FROM grids.records WHERE id = ${created.data.id}::uuid`;
        expect(stored.finalized_at !== null).toBe(valid);
        expect(stored.version).toBe(valid ? 2 : 1);
        const changed = await update(parties.id, partner.data.id, parties.values({ name: "Changed buyer" }), actorId, "workflow");
        if (!changed.ok) throw new Error(changed.error.message);
        const reread = await get(bills.id, created.data.id);
        expect(reread?.data[bills.ids.party_name!]).toBe(valid ? "Original buyer" : "Changed buyer");
        const docs = await sql`SELECT id FROM grids.documents WHERE base_id = ${baseId}::uuid`;
        expect(docs).toHaveLength(0);
      } finally {
        await deleteTestWorkflowScope(baseId);
        await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
        await sql`DELETE FROM auth.access WHERE user_id = ${actorId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
      }
    },
    30_000,
  );
}
