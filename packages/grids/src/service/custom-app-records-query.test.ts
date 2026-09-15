import { expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import type { DslQueryPreviewResponse } from "../contracts";
import { CustomAppCapabilitiesSchema, CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { buildCustomAppQueryContext } from "../custom-apps/query-context";
import { executePublishedCustomAppRecords } from "./custom-app-records-query";
import * as runtimeQuery from "./custom-app-runtime-query";

test("Records admission retains the same labeled byte-budget page as presentation", async () => {
  const originalSecret = process.env.APP_SECRET;
  process.env.APP_SECRET = "records-admission-test-secret";
  const tableId = "00000000-0000-4000-8000-000000000001";
  const recordId = "00000000-0000-4000-8000-000000000002";
  const definition = CustomAppDefinitionSchema.parse({
    schemaVersion: 5,
    kind: "grids.custom-app",
    id: "APP001",
    baseId: "BASE01",
    name: "Records",
    startPageId: "home",
    pages: [
      {
        id: "home",
        title: "Records",
        rows: [
          {
            id: "row",
            columns: [
              {
                id: "main",
                span: 12,
                blocks: [
                  {
                    id: "list",
                    type: "records",
                    source: { kind: "gql", query: "from table Tasks\nselect Name" },
                    display: { kind: "table", columnIds: [] },
                    searchable: true,
                    pageSize: 25,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const page = definition.pages[0]!;
  const block = page.rows[0]!.columns[0]!.blocks[0]!;
  if (block.type !== "records") throw new Error("Missing Records block");
  // The query layer owns byte fitting. Both consumers must request its exact
  // same labeled page, including a budget-truncated result and next cursor.
  const response: DslQueryPreviewResponse = {
    ok: true,
    mode: "rows",
    columns: [],
    limit: 25,
    truncated: true,
    rows: [{ recordId, values: { relationLabel: "x".repeat(300_000) } }],
    page: { size: 25, start: 0, returned: 1, nextCursor: "next-budget-page" },
  };
  const query = spyOn(runtimeQuery, "executePublishedCustomAppQuery").mockResolvedValue(response);
  try {
    const input: Parameters<typeof executePublishedCustomAppRecords>[0] = {
      baseId: "00000000-0000-4000-8000-000000000003",
      customAppId: "00000000-0000-4000-8000-000000000004",
      publishedAt: "2026-09-15T00:00:00Z",
      page,
      pageParams: {},
      block,
      capabilities: CustomAppCapabilitiesSchema.parse({
        views: [],
        recordQueries: [
          {
            pageId: "home",
            blockId: "list",
            primaryTableId: tableId,
            planHash: "a".repeat(64),
            tableIds: [tableId],
          },
        ],
      }),
      context: buildCustomAppQueryContext({
        user: null,
        authSubjectIds: [],
        page,
        pageParams: {},
        pageUrl: "/apps/APP001/home",
        app: { shortId: "APP001", name: "Records" },
        base: { shortId: "BASE01", name: "Tasks" },
        dateConfig: { timeZone: "UTC" },
        now: new Date("2026-09-15T00:00:00Z"),
      }),
      signal: new AbortController().signal,
      timeZone: "UTC",
      viewer: { userId: null, userGroups: [], serviceAccountId: null },
      viewerUserId: null,
      viewerServiceAccountId: null,
      search: "task",
      client: sql,
    };
    const rendered = await executePublishedCustomAppRecords(input);
    const admitted = await executePublishedCustomAppRecords({ ...input, includePresentation: false });
    expect(query).toHaveBeenCalledTimes(2);
    const first = query.mock.calls[0]![0];
    const second = query.mock.calls[1]![0];
    expect(second).toEqual(first);
    expect(second).toMatchObject({ client: sql, labelRelationValues: true, maxResultBytes: 512_000, pageSize: 25 });
    expect(admitted?.response).toEqual(rendered?.response);
    expect(admitted?.response).toBe(response);
  } finally {
    query.mockRestore();
    if (originalSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalSecret;
  }
});
