import { beforeAll, describe, expect, spyOn } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { fromPublicFormConfig } from "../../api/form-api-shared";
import { Hono } from "hono";
import { createCustomAppsApi } from "../../api/custom-apps";
import type { CustomAppDefinition } from "../../custom-apps/contracts";
import { postgresTest, testShortId, testUuid } from "../../integration-test-utils";
import { migrate } from "../../migrate";
import { gridsService } from "../../service";
import { grantAccess } from "../../service/access";
import { apply, plan, publish } from "../../service/custom-apps";
import "../_components/ssr-test-plugin";

const { default: customAppPage } = await import("./page");

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("published App SSR availability", () => {
  postgresTest("renders public record and view bindings without UUIDs in the browser contract", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const fieldId = testUuid();
    const recordId = testUuid();
    const childId = testUuid();
    const relationId = testUuid();
    const otherRelationId = testUuid();
    const otherRelationPublicId = testShortId("F");
    const otherFieldId = testUuid();
    const otherFieldPublicId = testShortId("F");
    const listFieldId = testUuid();
    const listFieldPublicId = testShortId("F");
    const childPublicId = testShortId("R");
    const relationPublicId = testShortId("F");
    const viewId = testUuid();
    const metricViewId = testUuid();
    const formId = testUuid();
    const basePublicId = testShortId("B");
    const tablePublicId = testShortId("T");
    const fieldPublicId = testShortId("F");
    const recordPublicId = testShortId("R");
    const viewPublicId = testShortId("V");
    const metricViewPublicId = testShortId("V");
    const formPublicId = testShortId("M");
    const appPublicId = testShortId("A");
    const accessIds: string[] = [];
    const recordGet = spyOn(gridsService.record, "get");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${basePublicId}, 'SSR public bindings')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Requests')`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldPublicId}, ${tableId}::uuid, 'Subject', 'text', '{}'::jsonb, 0)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${recordPublicId}, ${tableId}::uuid, ${{ [fieldId]: "Public binding survives SSR" }}::jsonb)`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${relationId}::uuid, ${relationPublicId}, ${tableId}::uuid, 'Lines', 'relation', ${{ targetTableId: tableId, cardinality: "multiple" }}::jsonb, 1)`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
        (${otherFieldId}::uuid, ${otherFieldPublicId}, ${tableId}::uuid, 'Other note', 'text', '{}'::jsonb, 2),
        (${otherRelationId}::uuid, ${otherRelationPublicId}, ${tableId}::uuid, 'Other links', 'relation', ${{ targetTableId: tableId, cardinality: "multiple" }}::jsonb, 3)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${childId}::uuid, ${childPublicId}, ${tableId}::uuid, ${{ [fieldId]: "Existing line", [otherFieldId]: "Not allowed through Lines" }}::jsonb)`;
      await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
        VALUES (${recordId}::uuid, ${relationId}::uuid, ${childId}::uuid)`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${listFieldId}::uuid, ${listFieldPublicId}, ${tableId}::uuid, 'Items', 'object_list', ${{
          fields: [
            { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } },
            { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
          ],
        }}::jsonb, 4)`;
      await sql`UPDATE grids.records SET data = data || ${{ [listFieldId]: [{ Amount: "0.10", Total1: "0.2" }] }}::jsonb
        WHERE id IN (${recordId}::uuid, ${childId}::uuid)`;
      await sql`INSERT INTO grids.views (id, short_id, table_id, name, source) VALUES
        (${viewId}::uuid, ${viewPublicId}, ${tableId}::uuid, 'Requests', ${`from table {${tablePublicId}}`}),
        (${metricViewId}::uuid, ${metricViewPublicId}, ${tableId}::uuid, 'Count', ${`from table {${tablePublicId}}\naggregate count(*) as Requests`})`;
      await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config)
        VALUES (${formId}::uuid, ${formPublicId}, ${tableId}::uuid, 'New request', ${{
          fields: [
            { kind: "user_input", fieldId },
            { kind: "user_input", fieldId: listFieldId },
            { kind: "user_input", fieldId: relationId, inlineCreate: { enabled: true, fields: [{ fieldId }, { fieldId: listFieldId }] } },
            {
              kind: "user_input",
              fieldId: otherRelationId,
              defaultValue: [childId],
              inlineCreate: { enabled: true, fields: [{ fieldId: otherFieldId }] },
            },
          ],
        }}::jsonb)`;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: appPublicId,
        baseId: basePublicId,
        name: "Public SSR app",
        startPageId: "home",
        sidebar: { actions: [{ id: "new-request", label: "New request", kind: "form", formId: formPublicId, fixedValues: {}, tone: "default" }] },
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [
              {
                id: "home-row",
                columns: [{ id: "home-column", span: 12, blocks: [{ id: "welcome", type: "markdown", markdown: "Home" }] }],
              },
            ],
          },
          {
            id: "detail",
            title: "Request detail",
            navigation: { visible: false },
            parameters: { request_id: { type: "record", tableId: tablePublicId, required: true } },
            record: { tableId: tablePublicId, id: { source: "PARAMS", path: "request_id" } },
            rows: [
              {
                id: "content",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "record", type: "record", fieldIds: [fieldPublicId], editableFieldIds: [] },
                      {
                        id: "records",
                        type: "records",
                        searchable: true,
                        pageSize: 25,
                        source: { kind: "view", viewId: viewPublicId },
                        display: { kind: "table", columnIds: [fieldPublicId] },
                      },
                      { id: "metric", type: "metrics", source: { kind: "view", viewId: metricViewPublicId } },
                      { id: "form", type: "form", formId: formPublicId, fixedValues: {} },
                      { id: "edit-form", type: "form", formId: formPublicId, mode: "edit", fixedValues: {} },
                      {
                        id: "actions",
                        type: "actions",
                        actions: [
                          {
                            id: "open",
                            kind: "navigate",
                            label: "Open same record",
                            pageId: "detail",
                            history: "push",
                            params: { request_id: { source: "RECORD", path: "id" } },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const applied = await apply(definition);
      if (!applied.ok) throw new Error(JSON.stringify(await plan(definition)));
      const published = await publish(applied.data.id);
      if (!published.ok) throw new Error(published.error.message);
      const grant = await grantAccess({
        resourceType: "customApp",
        resourceId: applied.data.id,
        permission: "read",
        principal: { type: "public" },
      });
      if (!grant.ok) throw new Error(grant.error.message);
      accessIds.push(grant.data.accessId);
      const app = new Hono<AuthContext>()
        .use("*", async (c, next) => {
          (c as unknown as { set: (key: string, value: unknown) => void }).set("runtime", { apps: [] });
          await next();
        })
        .get("/:shortId/:pageId", ...customAppPage);
      const response = await app.request(`/${appPublicId}/detail?request_id=${recordPublicId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Public binding survives SSR");
      expect(html).toContain(`request_id=${recordPublicId}`);
      expect(html).toContain(formPublicId);
      expect(html).toContain(fieldPublicId);
      expect(html).toContain("edit-form/submit");
      expect(html).toContain('value="Public binding survives SSR"');
      expect(html).toContain('value="Existing line"');
      expect(html).not.toContain(childId);
      expect(html).not.toContain(relationId);
      for (const id of [baseId, tableId, fieldId, recordId, viewId, metricViewId, formId]) expect(html).not.toContain(id);
      expect(recordGet.mock.calls.some(([id, record]) => id === tableId && record === recordId)).toBe(true);
      const api = createCustomAppsApi();
      const discovered = await api.request(`/runtime/${appPublicId}/detail?request_id=${recordPublicId}`);
      expect(discovered.status).toBe(200);
      const discoveredPage = await discovered.json();
      const discoveredForm = discoveredPage.blocks.find((block: { id: string }) => block.id === "edit-form").form;
      const createForm = discoveredPage.blocks.find((block: { id: string }) => block.id === "form").form;
      expect(createForm.relationLabels[childPublicId]).toBe("Existing line");
      expect(discoveredPage.sidebarActions[0].relationLabels[childPublicId]).toBe("Existing line");
      expect(
        createForm.form.config.fields.find((field: { fieldId: string }) => field.fieldId === otherRelationPublicId).defaultValue,
      ).toEqual([childPublicId]);
      expect(discoveredForm.initialRecord.values[otherRelationPublicId]).toEqual([]);
      const roundtrip = await fromPublicFormConfig(tableId, createForm.form.config);
      const roundtripRelation = roundtrip?.fields.find((entry) => entry.fieldId === otherRelationId);
      expect(roundtripRelation?.kind === "user_input" ? roundtripRelation.defaultValue : null).toEqual([childId]);
      expect(discoveredForm.inlineTargetFields[tablePublicId].map((field: { id: string }) => field.id).sort()).toEqual(
        [fieldPublicId, otherFieldPublicId, listFieldPublicId].sort(),
      );
      expect(discoveredForm.initialRecord.values[listFieldPublicId]).toEqual([{ Amount: "0.10" }]);
      expect(discoveredForm.initialRecord.inlineCreates[relationPublicId][0].data).toEqual({
        [fieldPublicId]: "Existing line",
        [listFieldPublicId]: [{ Amount: "0.10" }],
      });
      expect(JSON.stringify(discoveredForm.initialRecord)).not.toContain("Not allowed through Lines");
      const editUrl = `/runtime/${appPublicId}/detail/edit-form/submit?request_id=${recordPublicId}`;
      const body = {
        version: 1,
        idempotencyKey: "published-edit",
        data: {
          [fieldPublicId]: "Edited through the published form",
          [relationPublicId]: [childPublicId],
          [listFieldPublicId]: discoveredForm.initialRecord.values[listFieldPublicId],
        },
        inlineUpdates: {
          [relationPublicId]: [
            {
              recordId: childPublicId,
              version: 1,
              data: {
                [fieldPublicId]: "Edited line",
                [listFieldPublicId]: discoveredForm.initialRecord.inlineCreates[relationPublicId][0].data[listFieldPublicId],
              },
            },
          ],
        },
      };
      const send = (url: string, payload: unknown) =>
        api.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const edited = await send(editUrl, body);
      expect(edited.status).toBe(200);
      expect(await edited.json()).toEqual({ recordId: recordPublicId });
      expect((await send(editUrl, body)).status).toBe(200);
      expect((await send(`/runtime/${appPublicId}/detail/form/submit?request_id=${recordPublicId}`, body)).status).toBe(400);
      expect((await send(editUrl, { ...body, idempotencyKey: "stale-edit" })).status).toBe(409);
      const [saved] = await sql<
        { data: Record<string, unknown>; version: number }[]
      >`SELECT data, version FROM grids.records WHERE id = ${recordId}::uuid`;
      expect(saved?.data[fieldId]).toBe("Edited through the published form");
      expect(saved?.version).toBe(2);
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid`;
      expect(count?.count).toBe(2);
      const [child] = await sql<
        { data: Record<string, unknown>; version: number }[]
      >`SELECT data, version FROM grids.records WHERE id = ${childId}::uuid`;
      expect(child?.data[fieldId]).toBe("Edited line");
      expect(child?.data[listFieldId]).toEqual([{ Amount: "0.10", Total1: "0.2" }]);
      expect(saved?.data[listFieldId]).toEqual([{ Amount: "0.10", Total1: "0.2" }]);
      expect(child?.version).toBe(2);
      // A shared customer/lookup target stays a selectable link, not an editor
      // for data also used by another parent. Server writes still recheck this.
      const otherParentId = testUuid();
      await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${otherParentId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
      await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
        VALUES (${otherParentId}::uuid, ${relationId}::uuid, ${childId}::uuid)`;
      const sharedResponse = await api.request(`/runtime/${appPublicId}/detail?request_id=${recordPublicId}`);
      expect(sharedResponse.status).toBe(200);
      const sharedPage = await sharedResponse.json();
      const editForm = sharedPage.blocks.find((block: { id: string }) => block.id === "edit-form").form;
      expect(editForm.initialRecord.values[relationPublicId]).toEqual([childPublicId]);
      expect(editForm.initialRecord.inlineCreates[relationPublicId]).toEqual([]);
      expect(editForm.relationLabels[childPublicId]).toBe("Edited line");
      expect(editForm.relationLookupFields).toContain(relationPublicId);
      const lookupUrl = `/runtime/${appPublicId}/detail/edit-form/relations/${relationPublicId}/lookup?request_id=${recordPublicId}`;
      const lookupResponse = await api.request(`${lookupUrl}&_search=Edited%20line&_limit=1`);
      expect(lookupResponse.status).toBe(200);
      expect(await lookupResponse.json()).toEqual({ items: [{ id: childPublicId, label: "Edited line" }] });
      const excluded = await api.request(`${lookupUrl}&_search=Edited%20line&_exclude=${childPublicId}`);
      expect(excluded.status).toBe(200);
      expect(await excluded.json()).toEqual({ items: [] });
      expect((await api.request(lookupUrl.replace(relationPublicId, fieldPublicId))).status).toBe(404);
      expect((await api.request(lookupUrl.replace("/edit-form/", "/missing-form/"))).status).toBe(404);
      expect((await api.request(`${lookupUrl}&_limit=51`)).status).toBe(400);
      await sql`UPDATE grids.fields SET position = position + 20, name = 'Unrelated renamed field' WHERE id = ${otherFieldId}::uuid`;
      expect((await api.request(`${lookupUrl}&_search=Edited%20line`)).status).toBe(200);
      expect(
        (
          await send(editUrl, {
            version: 2,
            idempotencyKey: "shared-link-only",
            data: { [fieldPublicId]: "Parent only", [relationPublicId]: [childPublicId] },
          })
        ).status,
      ).toBe(200);
      expect((await send(editUrl, { ...body, version: 3, idempotencyKey: "shared-child-forged" })).status).toBe(400);
      await sql`UPDATE grids.fields SET presentable = TRUE WHERE id = ${otherFieldId}::uuid`;
      expect((await api.request(lookupUrl)).status).toBe(404);
      const driftResponse = await api.request(`/runtime/${appPublicId}/detail?request_id=${recordPublicId}`);
      if (driftResponse.status === 200) {
        const drift = await driftResponse.json();
        expect(drift.blocks.find((block: { id: string }) => block.id === "edit-form").form.ok).toBe(false);
      } else expect(driftResponse.status).toBe(404);
      expect((await app.request(`/${appPublicId}/detail?request_id=${recordId}`)).status).toBe(404);
      await sql`UPDATE grids.fields SET short_id = ${testShortId("F")} WHERE id = ${fieldId}::uuid`;
      expect((await app.request(`/${appPublicId}/detail?request_id=${recordPublicId}`)).status).toBe(404);
    } finally {
      recordGet.mockRestore();
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });

  postgresTest("rejects unavailable pages and skips unavailable block data before rendering", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const fieldId = testUuid();
    const viewId = testUuid();
    const basePublicId = testShortId("B");
    const tablePublicId = testShortId("T");
    const fieldPublicId = testShortId("F");
    const viewPublicId = testShortId("V");
    const appPublicId = testShortId("A");
    const accessIds: string[] = [];
    const viewGet = spyOn(gridsService.view, "get");

    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${basePublicId}, 'SSR availability')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Requests')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldPublicId}, ${tableId}::uuid, 'Subject', 'text', '{}'::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.views (id, short_id, table_id, name, source)
        VALUES (${viewId}::uuid, ${viewPublicId}, ${tableId}::uuid, 'Private requests', ${`from table {${tablePublicId}}`})
      `;

      const unavailable = `from table {${tablePublicId}}\nlimit 1`;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: appPublicId,
        baseId: basePublicId,
        name: "SSR guard app",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [
              {
                id: "content",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "private-records",
                        type: "records",
                        searchable: true,
                        pageSize: 25,
                        title: "Unavailable records must not render",
                        source: { kind: "view", viewId: viewPublicId },
                        display: { kind: "table", columnIds: [fieldPublicId] },
                        availableWhen: { query: unavailable },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "denied",
            title: "Denied page must not render",
            navigation: { visible: false },
            parameters: {},
            availableWhen: { query: unavailable },
            rows: [
              {
                id: "content",
                columns: [{ id: "main", span: 12, blocks: [{ id: "copy", type: "markdown", markdown: "Denied content" }] }],
              },
            ],
          },
        ],
      };

      const applied = await apply(definition);
      expect(applied.ok).toBe(true);
      if (!applied.ok) throw new Error(applied.error.message);
      const published = await publish(applied.data.id);
      expect(published.ok).toBe(true);
      const grant = await grantAccess({
        resourceType: "customApp",
        resourceId: applied.data.id,
        permission: "read",
        principal: { type: "public" },
      });
      expect(grant.ok).toBe(true);
      if (!grant.ok) throw new Error(grant.error.message);
      accessIds.push(grant.data.accessId);

      const app = new Hono<AuthContext>()
        .use("*", async (c, next) => {
          (c as unknown as { set: (key: string, value: unknown) => void }).set("runtime", { apps: [] });
          await next();
        })
        .get("/:shortId/:pageId", ...customAppPage);
      const home = await app.request(`/${appPublicId}/home`);
      expect(home.status).toBe(200);
      expect(await home.text()).not.toContain("Unavailable records must not render");
      expect(viewGet).not.toHaveBeenCalled();

      const denied = await app.request(`/${appPublicId}/denied`);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("location")).toBeNull();

      // Revoke only this fixture's public grant: the same published page now
      // needs login, not a misleading 404. Return paths never become origins.
      await sql`DELETE FROM auth.access WHERE id = ${grant.data.accessId}::uuid`;
      const requested = `/${appPublicId}/home?record=ABC123&next=https%3A%2F%2Fevil.test`;
      const protectedPage = await app.request(requested);
      expect(protectedPage.status).toBe(302);
      const location = new URL(protectedPage.headers.get("location")!, "https://cloud.test");
      expect(location.origin).toBe("https://cloud.test");
      expect(location.pathname).toBe("/auth/login");
      expect(location.searchParams.get("redirectTo")).toBe(requested);
      expect(protectedPage.headers.get("cache-control")).toContain("no-store");
      expect((await app.request(`/${appPublicId}/missing`)).status).toBe(404);
      expect((await app.request("/NOAPP1/home")).status).toBe(404);

      await sql`UPDATE grids.custom_apps SET published_definition = NULL WHERE id = ${applied.data.id}::uuid`;
      const unpublished = await app.request(`/${appPublicId}/home`);
      expect(unpublished.status).toBe(404);
      expect(unpublished.headers.get("location")).toBeNull();
    } finally {
      viewGet.mockRestore();
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });
});
