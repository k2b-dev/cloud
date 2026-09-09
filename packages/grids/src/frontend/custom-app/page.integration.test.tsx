import { beforeAll, describe, expect, spyOn } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
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
      await sql`INSERT INTO grids.views (id, short_id, table_id, name, source) VALUES
        (${viewId}::uuid, ${viewPublicId}, ${tableId}::uuid, 'Requests', ${`from table {${tablePublicId}}`}),
        (${metricViewId}::uuid, ${metricViewPublicId}, ${tableId}::uuid, 'Count', ${`from table {${tablePublicId}}\naggregate count(*) as Requests`})`;
      await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config)
        VALUES (${formId}::uuid, ${formPublicId}, ${tableId}::uuid, 'New request', ${{ fields: [{ kind: "user_input", fieldId }] }}::jsonb)`;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: appPublicId,
        baseId: basePublicId,
        name: "Public SSR app",
        startPageId: "home",
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
      for (const id of [baseId, tableId, fieldId, recordId, viewId, metricViewId, formId]) expect(html).not.toContain(id);
      expect(recordGet.mock.calls.some(([id, record]) => id === tableId && record === recordId)).toBe(true);
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
    } finally {
      viewGet.mockRestore();
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });
});
