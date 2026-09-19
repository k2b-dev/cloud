import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { createCustomAppsApi } from "../api/custom-apps";
import { FormConfigSchema } from "../contracts";
import { postgresTest, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, revokeAccess } from "../service/access";
import { listByBase } from "../service/custom-apps";
import { projectPublicId, resolvePublicId, type PublicResourceType } from "../service/public-resources";
import { get as getRecord } from "../service/records";
import { instantiate } from "../service/templates";
import { runGridsWorkflowRun } from "../service/workflow-runtime";
import { deleteTestWorkflowScope } from "../service/workflow-test-fixture";
import { getTemplates } from ".";

const requiredPublicId = async (type: PublicResourceType, id: string) => {
  const publicId = await projectPublicId(type, id);
  if (!publicId) throw new Error(`Missing public ID for ${type}`);
  return publicId;
};

const userFor = (id: string): User => ({
  id,
  uid: id,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Template",
  sn: "Reader",
  displayName: "Template reader",
  mail: "reader@example.invalid",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST !== "1") return;
  const [database] = await sql`SELECT current_database() AS name`;
  if (!database.name.startsWith("grids_verify_")) throw new Error("Template runtime tests require an isolated grids_verify_ database");
  await migrate();
});

describe("published template user journeys", () => {
  for (const scenario of [
    { template: "bookshop", form: "add_order_line" },
    { template: "finance", form: "log_expense" },
    { template: "inventory", form: "request_loan" },
  ]) {
    postgresTest(
      `${scenario.template}: app readers can read pages and finish the primary form without Base access`,
      async () => {
        const actorId = testUuid();
        const secondActorId = testUuid();
        for (const id of [actorId, secondActorId]) {
          await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
          VALUES (${id}::uuid, ${id}, 'local', 'user', 'Template reader', 'Template', 'Reader')`;
        }
        let baseId: string | undefined;
        try {
          const installed = await instantiate(scenario.template, { withSampleData: true }, actorId, "en");
          if (!installed.ok) throw new Error(installed.error.message);
          baseId = installed.data.id;
          const baseGrants = await sql<
            Array<{ access_id: string }>
          >`SELECT access_id::text FROM grids.base_access WHERE base_id = ${baseId}::uuid`;
          for (const grant of baseGrants) expect((await revokeAccess(grant.access_id)).ok).toBe(true);
          expect(await sql`SELECT 1 FROM grids.base_access WHERE base_id = ${baseId}::uuid`).toHaveLength(0);

          let actor = userFor(actorId);
          const api = new Hono<AuthContext>();
          api.use("*", async (c, next) => {
            c.set("actor", { kind: "user", user: actor });
            c.set("accessSubject", { type: "user", userId: actor.id });
            c.set("user", actor);
            await next();
          });
          api.route(
            "/",
            createCustomAppsApi({ loadOptionalActor: async (_c, next) => next(), requireAuthenticated: async (_c, next) => next() }),
          );
          const apps = await listByBase(baseId);
          const definition = getTemplates("en").find((template) => template.id === scenario.template)!;
          const formSpec = definition.forms!.find((form) => form.key === scenario.form)!;
          const [formRow] = await sql<Array<{ short_id: string; config: unknown; table_id: string }>>`
          SELECT f.short_id, f.config, f.table_id::text FROM grids.forms f JOIN grids.tables t ON t.id = f.table_id
          WHERE t.base_id = ${baseId}::uuid AND f.name = ${formSpec.name}`;
          if (!formRow) throw new Error(`Missing primary form ${scenario.form}`);
          const tableSpec = definition.tables.find((table) => table.key === formSpec.table)!;
          const installedFields = await sql<Array<{ id: string; short_id: string; name: string }>>`
          SELECT id::text, short_id, name FROM grids.fields WHERE table_id = ${formRow.table_id}::uuid AND deleted_at IS NULL`;
          const installedField = (key: string) => {
            const name = tableSpec.fields.find((field) => field.key === key)?.name;
            const field = installedFields.find((field) => field.name === name);
            if (!field) throw new Error(`Missing ${formSpec.table}.${key}`);
            return field;
          };
          const form = FormConfigSchema.parse(formRow.config);
          const requiredTablePublicId = await requiredPublicId("table", formRow.table_id);
          const [seedRow] = await sql<Array<{ id: string }>>`
          SELECT id::text FROM grids.records WHERE table_id = ${formRow.table_id}::uuid AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`;
          const seed = seedRow ? await getRecord(formRow.table_id, seedRow.id) : null;
          if (!seed) throw new Error("Missing seed for form journey");
          const payload: Record<string, unknown> = {};
          for (const entry of form.fields) {
            if (entry.kind !== "user_input") continue;
            const [field] = await sql<
              Array<{ short_id: string; type: string }>
            >`SELECT short_id, type FROM grids.fields WHERE id = ${entry.fieldId}::uuid`;
            if (!field) throw new Error("Missing form field");
            const value = seed.data[entry.fieldId];
            if (value == null) continue;
            payload[field.short_id] =
              field.type === "relation" && Array.isArray(value)
                ? await Promise.all(value.map((id: string) => requiredPublicId("record", id)))
                : value;
          }
          if (scenario.template === "bookshop") {
            payload[installedField("quantity").short_id] = "2";
            payload[installedField("unit_price").short_id] = "19.90";
          }
          let submitted = false;
          for (const app of apps) {
            if (!app.publishedDefinition) throw new Error("Unpublished template app");
            if (scenario.template === "inventory" && app.publishedDefinition.pages.some((page) => page.id === "catalog")) {
              const privateFields = await sql<Array<{ id: string }>>`
              SELECT f.id::text FROM grids.fields f JOIN grids.tables t ON t.id = f.table_id
              WHERE t.base_id = ${baseId}::uuid AND t.name = 'Items' AND f.name IN ('Notes', 'Replacement value')`;
              expect(privateFields).toHaveLength(2);
              const exposedFields = app.publishedCapabilities!.records.flatMap((capability) => capability.fieldIds);
              for (const field of privateFields) expect(exposedFields).not.toContain(field.id);
              expect(app.publishedDefinition.pages.some((page) => page.id === "item")).toBe(false);
            }
            const grant = await grantAccess({
              resourceType: "customApp",
              resourceId: app.id,
              permission: "read",
              principal: { type: "user", userId: actorId },
            });
            if (!grant.ok) throw new Error(grant.error.message);
            const paramsFor = async (page: (typeof app.publishedDefinition.pages)[number]) => {
              const params = new URLSearchParams();
              for (const [key, param] of Object.entries(page.parameters)) {
                const tableId = await resolvePublicId("table", param.tableId);
                const candidates = await sql<
                  Array<{ short_id: string; data: Record<string, unknown> }>
                >`SELECT short_id, data FROM grids.records WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL ORDER BY created_at, id`;
                const [delivery] = await sql<
                  Array<{ id: string }>
                >`SELECT id::text FROM grids.fields WHERE table_id = ${tableId}::uuid AND name = 'Summary delivery'`;
                const record = delivery
                  ? candidates.find((candidate) => JSON.stringify(candidate.data[delivery.id]) === '["ready"]')
                  : candidates[0];
                if (!record) throw new Error(`No sample for ${page.id}.${key}`);
                params.set(key, record.short_id);
              }
              return params;
            };
            for (const page of app.publishedDefinition.pages) {
              const params = await paramsFor(page);
              const url = `/runtime/${app.shortId}/${page.id}?${params}`;
              const response = await api.request(url);
              expect(response.status, `${url}: ${await response.clone().text()}`).toBe(200);
              const body = await response.json();
              expect(body.blocks.length).toBeGreaterThan(0);
              for (const block of body.blocks) {
                for (const kind of ["records", "metrics", "chart", "form"]) {
                  if (block[kind])
                    expect(block[kind].ok, `${scenario.template}/${page.id}/${block.id}: ${JSON.stringify(block[kind])}`).toBe(true);
                }
                if (block.recordsEndpoint) {
                  const endpoint = new URL(block.recordsEndpoint, "http://localhost");
                  const records = await api.request(endpoint.pathname.replace(/^\/api\/grids\/apps/, "") + endpoint.search);
                  expect(records.status, `${endpoint}: ${await records.clone().text()}`).toBe(200);
                }
              }
              const primary = page.rows
                .flatMap((row) => row.columns.flatMap((column) => column.blocks))
                .find((block) => block.type === "form" && block.formId === formRow.short_id && block.mode !== "edit");
              const sidebar = app.publishedDefinition.sidebar?.actions?.find(
                (action) => action.kind === "form" && action.formId === formRow.short_id,
              );
              if (submitted || (!primary && !sidebar)) continue;
              const surface = primary?.type === "form" ? primary : sidebar;
              if (!surface) continue;
              const values = { ...payload };
              for (const fieldId of Object.keys(surface.fixedValues ?? {})) delete values[fieldId];
              const endpoint = primary
                ? `/runtime/${app.shortId}/${page.id}/${primary.id}/submit?${params}`
                : `/runtime/${app.shortId}/sidebar/forms/${sidebar!.id}/submit`;
              const post = () =>
                api.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
              const created = await post();
              expect(created.status, await created.clone().text()).toBe(201);
              const result = await created.json();
              const id = await resolvePublicId("record", result.recordId);
              expect(id).not.toBeNull();
              const record = await getRecord(formRow.table_id, id!);
              expect(record?.createdBy).toBe(actorId);
              expect(record?.data).toBeDefined();
              if (scenario.template === "bookshop") expect(Number(record?.data[installedField("line_total").id])).toBe(39.8);
              if (scenario.template === "finance") {
                expect(record?.data[installedField("type").id]).toEqual(["expense"]);
                expect(record?.data[installedField("cleared").id]).toBe(false);
                expect(record?.data[installedField("receipt_sent").id]).toEqual(["ready"]);
              }
              if (scenario.template === "inventory") {
                expect(record?.data[installedField("status").id]).toEqual(["requested"]);
                expect(record?.data[installedField("availability_confirmed").id]).toBe(false);
              }
              const detail = app.publishedDefinition.pages.find((candidate) => candidate.record?.tableId === requiredTablePublicId);
              if (!detail?.record) throw new Error("Created record has no reachable detail page");
              const target = new URL(
                result.navigateTo ?? `/apps/${app.shortId}/${detail.id}?${detail.record.id.path}=${result.recordId}`,
                "http://localhost",
              );
              const readUrl = target.pathname.replace(`/apps/${app.shortId}`, `/runtime/${app.shortId}`) + target.search;
              const reread = await api.request(readUrl);
              expect(reread.status, await reread.clone().text()).toBe(200);
              if (scenario.template === "bookshop") {
                for (const [publicFieldId, binding] of Object.entries(surface.fixedValues ?? {})) {
                  if (binding.source !== "PARAMS" && binding.source !== "RECORD") continue;
                  const fieldId = await resolvePublicId("field", publicFieldId);
                  const boundRecordId = await resolvePublicId(
                    "record",
                    params.get(binding.source === "PARAMS" ? binding.path : page.record!.id.path)!,
                  );
                  expect(record?.data[fieldId!]).toEqual([boundRecordId]);
                }
              }
              if (scenario.template === "bookshop") {
                const lines = page.rows
                  .flatMap((row) => row.columns.flatMap((column) => column.blocks))
                  .find((block) => block.type === "records" && block.rowActions?.some((action) => action.id === "remove"));
                if (!lines || lines.type !== "records") throw new Error("Missing line removal action");
                const removed = await api.request(`/runtime/${app.shortId}/${page.id}/${lines.id}/row-actions/remove?${params}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ operationId: testUuid(), rowId: result.recordId }),
                });
                expect(removed.status, await removed.clone().text()).toBe(202);
                const accepted = await removed.json();
                const runId = await resolvePublicId("workflowRun", accepted.runId);
                if (!runId) throw new Error("Missing removal run");
                let state = "queued";
                for (let attempt = 0; attempt < 30 && !["succeeded", "failed", "needs_attention", "canceled"].includes(state); attempt++) {
                  await runGridsWorkflowRun(runId);
                  const [run] = await sql<
                    Array<{ state: string; error: unknown }>
                  >`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
                  if (!run) throw new Error("Removal run disappeared");
                  state = run.state;
                  if (state === "failed" || state === "needs_attention") throw new Error(JSON.stringify(run.error));
                }
                expect(state).toBe("succeeded");
                expect(await getRecord(formRow.table_id, id!)).toBeNull();
              }
              if (scenario.template === "inventory") {
                const secondGrant = await grantAccess({
                  resourceType: "customApp",
                  resourceId: app.id,
                  permission: "read",
                  principal: { type: "user", userId: secondActorId },
                });
                expect(secondGrant.ok).toBe(true);
                actor = userFor(secondActorId);
                expect((await api.request(readUrl)).status).toBe(404);
                actor = userFor(actorId);
              }
              submitted = true;
            }
            expect((await revokeAccess(grant.data.accessId)).ok).toBe(true);
            const landing = app.publishedDefinition.pages.find((page) => Object.keys(page.parameters).length === 0)!;
            expect((await api.request(`/runtime/${app.shortId}/${landing.id}`)).status).toBe(404);
          }
          expect(submitted, `${scenario.template} primary form reached`).toBe(true);
        } finally {
          if (baseId) {
            await deleteTestWorkflowScope(baseId);
            await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
          }
          for (const id of [actorId, secondActorId]) {
            await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
            await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
          }
        }
      },
      120_000,
    );
  }
});
