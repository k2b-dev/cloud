import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../../../integration-test-utils";
import { migrate } from "../../../migrate";
import { projectPublicWorkspaceState } from "./workspace-public-state";
import { loadGridsWorkspaceState } from "./workspace-state";

type Fixture = {
  userId: string;
  accessId: string;
  baseId: string;
  basePublicId: string;
  tablePublicId: string;
  titleId: string;
  titlePublicId: string;
  peoplePublicId: string;
  adaId: string;
  adaPublicId: string;
};

const createFixture = async (): Promise<Fixture> => {
  const userId = testUuid();
  const baseId = testUuid();
  const basePublicId = testShortId("B");
  const tasksId = testUuid();
  const tablePublicId = testShortId("T");
  const peopleTableId = testUuid();
  const titleId = testUuid();
  const titlePublicId = testShortId("F");
  const peopleId = testUuid();
  const peoplePublicId = testShortId("F");
  const nameId = testUuid();
  const adaId = testUuid();
  const adaPublicId = testShortId("R");
  const graceId = testUuid();
  const alphaId = testUuid();
  const betaId = testUuid();
  const gammaId = testUuid();

  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${userId}::uuid, ${userId}, 'local', 'user', 'Table reader', 'Table', 'Reader')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${basePublicId}, 'Shared URLs')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${tasksId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Tasks', 0),
      (${peopleTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'People', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable) VALUES
      (${titleId}::uuid, ${titlePublicId}, ${tasksId}::uuid, 'Title', 'text', '{}'::jsonb, 0, TRUE),
      (${peopleId}::uuid, ${peoplePublicId}, ${tasksId}::uuid, 'People', 'relation', ${{ targetTableId: peopleTableId }}::jsonb, 1, FALSE),
      (${nameId}::uuid, ${testShortId("F")}, ${peopleTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE)
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data) VALUES
      (${adaId}::uuid, ${adaPublicId}, ${peopleTableId}::uuid, ${{ [nameId]: "Ada" }}::jsonb),
      (${graceId}::uuid, ${testShortId("R")}, ${peopleTableId}::uuid, ${{ [nameId]: "Grace" }}::jsonb),
      (${alphaId}::uuid, ${testShortId("R")}, ${tasksId}::uuid, ${{ [titleId]: "Alpha" }}::jsonb),
      (${betaId}::uuid, ${testShortId("R")}, ${tasksId}::uuid, ${{ [titleId]: "Beta" }}::jsonb),
      (${gammaId}::uuid, ${testShortId("R")}, ${tasksId}::uuid, ${{ [titleId]: "Gamma" }}::jsonb)
  `;
  await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position) VALUES
      (${alphaId}::uuid, ${peopleId}::uuid, ${adaId}::uuid, 0),
      (${betaId}::uuid, ${peopleId}::uuid, ${graceId}::uuid, 0),
      (${gammaId}::uuid, ${peopleId}::uuid, ${adaId}::uuid, 0),
      (${gammaId}::uuid, ${peopleId}::uuid, ${graceId}::uuid, 1)
  `;
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'read'::auth.permission_level) RETURNING id::text AS id
  `;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access!.id}::uuid)`;
  return { userId, accessId: access!.id, baseId, basePublicId, tablePublicId, titleId, titlePublicId, peoplePublicId, adaId, adaPublicId };
};

const cleanupFixture = async (fixture: Fixture) => {
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.access WHERE id = ${fixture.accessId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.userId}::uuid`;
};

/** Mirrors the SSR table page: load the workspace state for the URL, then project it to the public page state. */
const loadTablePage = async (fixture: Fixture, search: Record<string, unknown>) => {
  const url = new URL(`http://cloud.test/app/grids/${fixture.basePublicId}/table/${fixture.tablePublicId}`);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const state = await loadGridsWorkspaceState(
    {
      user: { id: fixture.userId, memberofGroupIds: [] },
      baseShortId: fixture.basePublicId,
      href: url.href,
      activeTableSlug: fixture.tablePublicId,
    },
    { latestMetadataEventCursor: async () => null, latestRecordEventCursor: async () => null },
  );
  if (state.kind !== "ok" || state.route.kind !== "records") throw new Error(`Expected a records page, got ${state.kind}`);
  const publicState = await projectPublicWorkspaceState(state);
  if (publicState.route.kind !== "records") throw new Error("Expected a public records page");
  return {
    titles: (state.route.initialData.items ?? []).map((record) => record.data[fixture.titleId]),
    initialState: publicState.route.initialState,
  };
};

let fixture: Fixture | null = null;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  fixture = await createFixture();
});

afterAll(async () => {
  if (fixture) await cleanupFixture(fixture);
});

describe("shared records page URLs", () => {
  postgresTest("reload the filter, sort, and search scope that Grids wrote with public IDs", async () => {
    const f = fixture!;
    const filter = { op: "AND" as const, filters: [{ fieldId: f.peoplePublicId, op: "containsAny", value: [f.adaPublicId] }] };
    const sort = [{ fieldId: f.titlePublicId, direction: "desc" as const }];

    const page = await loadTablePage(f, { filter, sort, q: "a", qFields: f.titlePublicId });

    expect(page.titles).toEqual(["Gamma", "Alpha"]);
    expect(page.initialState.query.filter).toEqual(filter);
    expect(page.initialState.query.sort).toEqual(sort);
    expect(page.initialState.search).toMatchObject({ q: "a", fieldIds: [f.titlePublicId] });
  });

  postgresTest("ignore stale field and record IDs instead of failing the page", async () => {
    const f = fixture!;
    const legacyFilter = { op: "AND", filters: [{ fieldId: f.peoplePublicId, op: "containsAny", value: [f.adaId] }] };

    const page = await loadTablePage(f, {
      filter: legacyFilter,
      sort: [{ fieldId: "GONE01", direction: "desc" }],
      q: "a",
      qFields: "GONE01",
    });

    expect(page.titles.sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(page.initialState.query.filter).toBeUndefined();
    expect(page.initialState.query.sort).toEqual([]);
    expect(page.initialState.search).toMatchObject({ q: "a", fieldIds: [] });
  });

  postgresTest("keep the search-scope fields that still exist", async () => {
    const f = fixture!;

    // "e" matches the title Beta and, through People, the name Grace on Beta and Gamma.
    const page = await loadTablePage(f, { q: "e", qFields: `GONE01,${f.titlePublicId}` });

    expect(page.titles).toEqual(["Beta"]);
    expect(page.initialState.search).toMatchObject({ q: "e", fieldIds: [f.titlePublicId] });
  });
});
