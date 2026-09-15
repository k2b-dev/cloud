import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { buildCustomAppQueryContext } from "../custom-apps/query-context";
import { createGermanBillingProfile, germanBillingProfile } from "../document-profiles/einvoice-de";
import { postgresTest, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess } from "../service/access";
import { executePublishedCustomAppQuery } from "../service/custom-app-runtime-query";
import { get as getApp } from "../service/custom-apps";
import { create, get, update } from "../service/records";
import { instantiateDefinition } from "../service/templates";
import { canExecuteRun, canExecuteWorkflow } from "../service/workflow-action-scope";
import { invokeCustomAppLauncher } from "../service/workflow-launcher-invocations";
import { getWorkflowRunScope } from "../service/workflow-runs";
import { runGridsWorkflowRun } from "../service/workflow-runtime";
import { createBillingTemplate } from "./billing";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST !== "1") return;
  const [db] = await sql`SELECT current_database() AS name`;
  if (!db.name.startsWith("grids_verify_")) throw new Error("Billing lifecycle requires an isolated grids_verify_ database");
  await migrate();
});

postgresTest(
  "published billing actions finish their own transitions with app access only",
  async () => {
    const startedAt = performance.now();
    const checkpoint = (phase: string) => console.info(`[billing app] ${phase}: ${Math.round(performance.now() - startedAt)}ms`);
    const profile = createGermanBillingProfile({
      render: async ({ xml }) => ({ pdf: new TextEncoder().encode(`%PDF-TEST\n${xml}`) }),
      extractEmbedded: async (pdf) => ({ filename: "factur-x.xml", xml: new TextDecoder().decode(pdf).slice("%PDF-TEST\n".length) }),
    });
    const render = spyOn(germanBillingProfile, "issue").mockImplementation((snapshot, context) => profile.issue(snapshot, context));
    try {
      const definition = createBillingTemplate("en");
      // Valid authoring shorthand must work with computed fields and App-only
      // access too; the shipped template's slim select must not hide that seam.
      const authoredBillPage = definition.customApps![0]!.definition.pages.find((page) => page.id === "bill")!;
      const authoredActions = authoredBillPage.rows
        .flatMap((row) => row.columns.flatMap((column) => column.blocks))
        .find((block) => block.id === "actions");
      if (authoredActions?.type !== "actions" || !("actions" in authoredActions)) throw new Error("Missing authored bill actions");
      const authoredIssue = authoredActions.actions.find((action) => action.id === "issue")!;
      authoredActions.actions.push({
        ...authoredIssue,
        id: "lookup-check",
        availableWhen: {
          query: { $formula: ["from table ", { $ref: "table", key: "bills" }, "\nwhere record.id = @params.bill_id\nlimit 1"] },
        },
      });
      const installed = await instantiateDefinition(definition, { withSampleData: false }, null, "en");
      if (!installed.ok) throw new Error(installed.error.message);
      checkpoint("template installed");
      const baseId = installed.data.id;
      const actorId = testUuid();
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Billing app reader', 'Billing', 'Reader')`;
      const [storedApp] = await sql`SELECT id::text FROM grids.custom_apps WHERE base_id = ${baseId}::uuid`;
      const app = await getApp(storedApp.id);
      if (!app?.publishedAt || !app.publishedCapabilities) throw new Error("Missing published app");
      const granted = await grantAccess({
        resourceType: "customApp",
        resourceId: app.id,
        permission: "read",
        principal: { type: "user", userId: actorId },
      });
      if (!granted.ok) throw new Error(granted.error.message);
      const principal = { userId: actorId, groupIds: [], serviceAccountId: null };
      const table = async (key: string) => {
        const spec = definition.tables.find((candidate) => candidate.key === key)!;
        const [row] = await sql`SELECT id::text FROM grids.tables WHERE base_id = ${baseId}::uuid AND name = ${spec.name}`;
        const fields = await sql<
          Array<{ id: string; name: string }>
        >`SELECT id::text, name FROM grids.fields WHERE table_id = ${row.id}::uuid`;
        const ids = Object.fromEntries(
          spec.fields.map((field) => [field.key, fields.find((candidate) => candidate.name === field.name)!.id]),
        );
        const values = (input: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(input).map(([key, value]) => [ids[key]!, value]));
        return { id: row.id as string, values };
      };
      const settings = await table("settings");
      const parties = await table("parties");
      const bills = await table("bills");
      const payments = await table("payments");
      const company = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
      const [issuer] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${settings.id}::uuid`;
      const setup = await update(
        settings.id,
        issuer.id,
        settings.values({ ...company, name: "Issuer", vat_id: "DE123456789", ready: true }),
        null,
        "workflow",
      );
      if (!setup.ok) throw new Error(setup.error.message);
      const partner = await create(parties.id, parties.values({ ...company, name: "Buyer", vat_id: "DE987654321" }), null, "workflow");
      if (!partner.ok) throw new Error(partner.error.message);
      const draftData = bills.values({
        kind: ["invoice"],
        settings: [issuer.id],
        party: [partner.data.id],
        invoice_date: "2026-09-15",
        service_date: "2026-09-01",
        due_date: "2026-09-30",
        buyer_reference: "Test",
        positions: [{ Label1: "Service", Unit01: ["C62"], Qty001: "1", Price1: "100.00", Vat001: ["vat019"] }],
      });
      const draft = await create(bills.id, draftData, null, "form");
      if (!draft.ok) throw new Error(draft.error.message);
      checkpoint("draft created");

      const start = async (
        pageId: string,
        blockId: string,
        actionId: string,
        pageParams: Record<string, string>,
        inputs: Record<string, string>,
        recordId?: string,
      ) => {
        const capability = app.publishedCapabilities!.workflowLaunchers.find(
          (candidate) =>
            "pageId" in candidate && candidate.pageId === pageId && candidate.blockId === blockId && candidate.actionId === actionId,
        )!;
        if (!capability) throw new Error(`Missing action ${actionId}`);
        const result = await invokeCustomAppLauncher({
          launcherId: capability.launcherId,
          operationId: testUuid(),
          expectedRevision: capability.revision,
          mode: "execute",
          principal,
          locale: "en",
          inputs,
          authorization: {
            kind: "custom-app-action",
            customAppId: app.id,
            publishedAt: app.publishedAt,
            pageId,
            pageParams,
            blockId,
            actionId,
            revision: capability.revision,
            timeZone: "UTC",
            ...(recordId ? { recordId } : {}),
          },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        checkpoint(`${actionId} accepted`);
        return result.data.runId;
      };
      const finish = async (runId: string) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          await runGridsWorkflowRun(runId);
          const [run] = await sql`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
          if (["failed", "succeeded", "needs_attention", "canceled"].includes(run.state)) {
            expect(run.state, JSON.stringify(run.error)).toBe("succeeded");
            checkpoint("run succeeded");
            return;
          }
        }
        throw new Error(`Run did not settle: ${runId}`);
      };
      const issue = () => start("bill", "actions", "issue", { bill_id: draft.data.id }, { bill: draft.data.shortId });
      // Exercise the real availability query separately so a denied launcher
      // reports query/configuration diagnostics instead of only FORBIDDEN.
      const billPage = app.publishedDefinition!.pages.find((page) => page.id === "bill")!;
      const issueBlock = billPage.rows
        .flatMap((row) => row.columns.flatMap((column) => column.blocks))
        .find((block) => block.id === "actions");
      if (issueBlock?.type !== "actions") throw new Error("Missing bill actions");
      const issueAction = issueBlock.actions.find((action) => action.id === "lookup-check")!;
      const issueAvailability = app.publishedCapabilities.availability.find(
        (capability) =>
          capability.target === "action" &&
          capability.pageId === "bill" &&
          capability.blockId === "actions" &&
          capability.actionId === "lookup-check",
      );
      if (!issueAvailability || !issueAction.availableWhen) throw new Error("Missing issue availability");
      const available = await executePublishedCustomAppQuery({
        baseId,
        source: issueAction.availableWhen.query,
        capability: issueAvailability,
        context: buildCustomAppQueryContext({
          user: { id: actorId, displayName: "Billing app reader", uid: actorId, mail: null },
          authSubjectIds: [actorId],
          app,
          base: installed.data,
          page: billPage,
          pageUrl: `/apps/${app.shortId}/bill?bill_id=${draft.data.shortId}`,
          pageParams: { bill_id: draft.data.shortId },
          dateConfig: { timeZone: "UTC" },
          now: new Date(),
        }),
        signal: new AbortController().signal,
        timeZone: "UTC",
        viewer: { userId: actorId, userGroups: [], serviceAccountId: null, isAdmin: false },
        maxRows: 1,
        maxResultBytes: 64_000,
      });
      expect(available.ok, JSON.stringify(available)).toBe(true);
      if (available.ok) expect(available.rows).toHaveLength(1);
      const issueRun = await issue();
      const scope = await getWorkflowRunScope(issueRun);
      if (!scope) throw new Error("Missing accepted run scope");
      // This actor has no Base grant: only the exact published App action can run.
      expect(await canExecuteWorkflow({ ...scope, workflowId: scope.workflow.id, authorization: { kind: "workflow" } })).toBe(false);
      await finish(issueRun);
      expect((await get(bills.id, draft.data.id))?.finalizedAt).not.toBeNull();
      expect(await canExecuteRun(scope)).toBe(true);
      await finish(await issue());
      const documents = await sql`SELECT id FROM grids.documents WHERE base_id = ${baseId}::uuid`;
      expect(documents).toHaveLength(1);
      expect(render).toHaveBeenCalledTimes(1);

      const payment = await create(
        payments.id,
        payments.values({ bill: [draft.data.id], date: "2026-09-16", amount: "119.00" }),
        null,
        "form",
      );
      if (!payment.ok) throw new Error(payment.error.message);
      await finish(await start("payment", "actions", "confirm", { payment_id: payment.data.id }, { payment: payment.data.shortId }));
      expect((await get(payments.id, payment.data.id))?.finalizedAt).not.toBeNull();
      const discarded = await create(bills.id, draftData, null, "form");
      if (!discarded.ok) throw new Error(discarded.error.message);
      await finish(await start("drafts", "bills", "discard", {}, { bill: discarded.data.shortId }, discarded.data.id));
      expect(await get(bills.id, discarded.data.id)).toBeNull();

      await sql`UPDATE grids.workflow_launchers SET enabled = false WHERE id = ${scope.launcherId}::uuid`;
      expect(await canExecuteRun(scope)).toBe(false);
      await sql`UPDATE grids.workflow_launchers SET enabled = true WHERE id = ${scope.launcherId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${granted.data.accessId}::uuid`;
      expect(await canExecuteRun(scope)).toBe(false);
    } finally {
      render.mockRestore();
    }
  },
  180_000,
);
