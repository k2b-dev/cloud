import { afterAll, beforeAll, expect, spyOn } from "bun:test";
import { type SQL, sql, type TransactionSQL } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { buildNotePaths, noteSlug } from "../lib/note-path";
import { migrate } from "../migrate";
import { type InsertedFixtureNotebook, insertFixtureNotebook } from "./large-notebook.test-fixture";
import { childrenQuery, createAtPath, listOutline, outlinePageQuery, resolvePath } from "./note-paths";
import { reindexBatchQuery, reindexNotebook } from "./note-refs";
import { overviewStats } from "./notebooks";
import {
  appendPositionQuery,
  create,
  listPaged,
  listPageQuery,
  move,
  readBatch,
  readBatchQuery,
  recentForUser,
  recentForUserQuery,
} from "./notes";
import { normalizeFilters, searchAcross, searchCondition, searchInNotebook, searchPageQuery } from "./search";
import { listNotesForTag } from "./tags";
import * as workspaceEvents from "./workspace-events";

const postgresTest = testFor("database");
const fixtures: InsertedFixtureNotebook[] = [];
const grants: string[] = [];
const pagination = { page: 1, perPage: 7, offset: 0 };
const marker = "serverguarduniqueneedle";

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const shape of ["small", "large"] as const) {
    const notebook = await insertFixtureNotebook(shape);
    fixtures.push(notebook);
    const grant = crypto.randomUUID();
    grants.push(grant);
    await sql`INSERT INTO auth.access (id, permission) VALUES (${grant}::uuid, 'read')`;
    await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook.id}::uuid, ${grant}::uuid)`;
    await sql`UPDATE notebooks.notes SET content_md = content_md || ${`\n${marker}\n`} WHERE id = ${notebook.page.id}::uuid`;
  }
  await sql`ANALYZE notebooks.notes`;
  await sql`ANALYZE notebooks.note_tags`;
}, 120_000);

afterAll(async () => {
  for (const notebook of fixtures) await notebook.remove();
  for (const id of grants) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
});

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Plans?: Plan[];
};
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const indexedPlan = async (query: SQL.Query<unknown>, indexes: string[], transaction?: TransactionSQL) => {
  const check = async (tx: TransactionSQL) => {
    // Small fixtures may rationally prefer sequential scans. This checks index eligibility,
    // rather than asserting a cost estimate for tiny tables.
    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    const [row] = await tx<{ "QUERY PLAN": { Plan: Plan }[] }[]>`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`;
    const plan = nodes(row!["QUERY PLAN"][0]!.Plan);
    expect(plan[0]!["Actual Rows"]).toBeLessThanOrEqual(100);
    expect(plan.filter((node) => ["notes", "note_tags"].includes(node["Relation Name"] ?? "") && node["Node Type"] === "Seq Scan")).toEqual(
      [],
    );
    for (const index of indexes) expect(plan.some((node) => node["Index Name"] === index)).toBe(true);
  };
  if (transaction) await check(transaction);
  else await sql.begin(check);
};

for (const [index, shape] of ["small", "large"].entries()) {
  postgresTest(`${shape}: outline pages, path segments and whole-notebook batches use bounded indexed reads`, async () => {
    const notebook = fixtures[index]!;
    const sorted = [...notebook.notes].sort((a, b) => a.id.localeCompare(b.id));
    const result = await listOutline({ notebookId: notebook.id, pagination: { limit: 7, offset: 3 } });
    expect(result.total).toBe(shape === "small" ? 13 : 20_000);
    expect(result.items.map((note) => note.id)).toEqual(sorted.slice(3, 10).map((note) => note.id));
    for (const note of result.items) {
      expect(note.parentShortId).toBe(notebook.notes.find((parent) => parent.id === note.parentId)?.shortId ?? null);
      expect(note.hasChildren).toBe(notebook.notes.some((child) => child.parentId === note.id));
      expect("contentMd" in note).toBe(false);
    }
    await indexedPlan(outlinePageQuery({ notebookId: notebook.id, pagination: { limit: 7, offset: 3 } }), ["idx_notes_notebook_id"]);
    const paths = buildNotePaths(notebook.notes, { mirror: false });
    const page = notebook.notes.find((note) => note.id === notebook.page.id)!;
    const resolved = await resolvePath({ notebookId: notebook.id, path: paths.get(page.id)! });
    expect(resolved.ok && resolved.note.id).toBe(page.id);
    await indexedPlan(childrenQuery(notebook.id, page.parentId), ["idx_notes_notebook_parent_position"]);
    const after = sorted[3]!.id;
    await indexedPlan(readBatchQuery({ notebookId: notebook.id, after }), ["idx_notes_notebook_id"]);
    await indexedPlan(reindexBatchQuery(notebook.id, after), ["idx_notes_notebook_id"]);
    const batch = await readBatch({ notebookId: notebook.id, after, includeContent: false });
    expect(batch.map((note) => note.id)).toEqual(sorted.slice(4, 104).map((note) => note.id));
    expect(batch.every((note) => note.contentMd === null)).toBe(true);
  });

  postgresTest(`${shape}: list/search ordering and indexed full text are independent of notebook size`, async () => {
    const notebook = fixtures[index]!;
    const list = await listPaged({ notebookId: notebook.id, query: marker, pagination: { limit: 7, offset: 0 } });
    expect(list.items.map((note) => note.id)).toEqual([notebook.page.id]);
    expect(list.total).toBe(1);
    await indexedPlan(listPageQuery({ notebookId: notebook.id, query: marker, pagination: { limit: 7, offset: 0 } }), [
      "idx_notes_search_document",
      "idx_notes_title_grams",
    ]);
    await indexedPlan(listPageQuery({ notebookId: notebook.id, pagination: { limit: 7, offset: 0 } }), ["idx_notes_notebook_list"]);
    const filtered = await searchInNotebook({ notebookId: notebook.id, filters: { query: marker }, pagination });
    expect(filtered.hits.map((hit) => hit.note.id)).toEqual([notebook.page.id]);
    expect(filtered.hits[0]!.snippet).toContain(marker);
    for (const query of [marker, ""]) {
      const filters = normalizeFilters({ query });
      const condition = sql`n.notebook_id = ${notebook.id}::uuid AND ${searchCondition(filters)}`;
      await indexedPlan(searchPageQuery({ filters, condition, pagination, backend: "native" }), [
        query ? "idx_notes_search_document" : "idx_notes_notebook_updated",
      ]);
    }
    const expected = [...notebook.notes]
      .reverse()
      .slice(0, 7)
      .map((note) => note.id);
    const recent = await searchInNotebook({ notebookId: notebook.id, filters: {}, pagination });
    expect(recent.hits.map((hit) => hit.note.id)).toEqual(expected);
    expect(recent.hits.every((hit) => hit.snippet === null)).toBe(true);
    const listed = await listPaged({ notebookId: notebook.id, pagination: { limit: 7, offset: 0 } });
    expect(listed.items.map((note) => note.id)).toEqual(expected);
    const stats = await overviewStats({ notebookIds: [notebook.id] });
    expect(stats[0]!.noteCount).toBe(notebook.notes.length);
    expect(stats[0]!.lastNoteAt).toBe(recent.hits[0]!.note.updatedAt);
  });
}

postgresTest("filter-only global search and recent notes use updated_at indexes; tags use the membership index", async () => {
  const notebook = fixtures[1]!;
  const filters = normalizeFilters({});
  await indexedPlan(searchPageQuery({ filters, condition: searchCondition(filters), pagination, backend: "native" }), [
    "idx_notes_updated",
  ]);
  const hits = await searchAcross({ userId: null, notebookId: notebook.id, filters: { query: marker }, pagination });
  expect(hits.hits.map((hit) => hit.note.id)).toEqual([notebook.page.id]);
  const recent = await recentForUser({ userId: "11111111-1111-4111-8111-111111111111", limit: 7 });
  expect(recent.length).toBeLessThanOrEqual(7);
  await indexedPlan(recentForUserQuery({ userId: "11111111-1111-4111-8111-111111111111", limit: 7 }), ["idx_notes_notebook_updated"]);
  const tags = await listNotesForTag({ notebookId: notebook.id, tag: "HANDBOOK", pagination: { limit: 7, offset: 0 } });
  expect(tags.items.length).toBe(7);
  const expected = await sql<{ id: string }[]>`SELECT note_id AS id FROM notebooks.note_tags t
    JOIN notebooks.notes n ON n.id = t.note_id WHERE t.notebook_id = ${notebook.id}::uuid AND t.tag = 'handbook'
    ORDER BY n.updated_at DESC, n.id DESC LIMIT 7`;
  expect(tags.items.map((note) => note.id)).toEqual(expected.map((note) => note.id));
  await indexedPlan(
    sql`SELECT n.id FROM notebooks.note_tags t JOIN notebooks.notes n ON n.id = t.note_id
    WHERE t.notebook_id = ${notebook.id}::uuid AND t.tag = 'handbook' ORDER BY n.updated_at DESC, n.id DESC LIMIT 7`,
    ["idx_note_tags_nb_tag"],
  );
  await indexedPlan(
    sql`SELECT updated_at FROM notebooks.notes WHERE notebook_id = ${notebook.id}::uuid ORDER BY updated_at DESC, id LIMIT 1`,
    ["idx_notes_notebook_updated"],
  );
});

postgresTest("paths resolve with the address slugs, including Unicode, capitals and collisions", async () => {
  const notebook = fixtures[0]!;
  const parent = notebook.notes.find((note) => note.id === notebook.folder.id)!;
  const paths = buildNotePaths(notebook.notes, { mirror: false });
  const parentPath = paths.get(parent.id)!;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const firstShort = testShortId();
  const secondShort = testShortId();
  try {
    await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, parent_id, title, content_md) VALUES
      (${first}::uuid, ${firstShort}, ${notebook.id}::uuid, ${parent.id}::uuid, 'Café', '# Café'),
      (${second}::uuid, ${secondShort}, ${notebook.id}::uuid, ${parent.id}::uuid, 'Cafe', '# Cafe')`;
    const candidates = [
      { shortId: firstShort, title: "Café", path: `${parentPath}/cafe` },
      { shortId: secondShort, title: "Cafe", path: `${parentPath}/cafe` },
    ];
    const result = await resolvePath({ notebookId: notebook.id, path: `${parentPath}/cafe` });
    expect(result.ok).toBe(false);
    if (!result.ok && result.problem.kind === "ambiguous") expect(result.problem.candidates).toEqual(expect.arrayContaining(candidates));
    else throw new Error("expected ambiguous path (HTTP 409)");
    const common = {
      notebookId: notebook.id,
      parentId: parent.id,
      parentPath: "",
      createParents: false,
      contentMd: "# Café",
      creatorId: null,
    };
    const duplicate = await createAtPath(common);
    expect(duplicate).toEqual({
      ok: false,
      problem: { kind: "title-exists", title: "Café", candidates: expect.arrayContaining(candidates) },
    });
    expect(await createAtPath({ ...common, parentPath: "absent", contentMd: "# New" })).toEqual({
      ok: false,
      problem: { kind: "missing", segment: "absent", parentPath },
    });
  } finally {
    await sql`DELETE FROM notebooks.notes WHERE id = ${first}::uuid OR id = ${second}::uuid`;
  }
});

postgresTest("title substrings keep LIKE semantics while body queries use word-start full text", async () => {
  const notebook = fixtures[0]!;
  const id = crypto.randomUUID();
  try {
    await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md)
      VALUES (${id}::uuid, ${testShortId()}, ${notebook.id}::uuid, 'Handbook SUBSTRINGxyz_100% done', '# Other\npartialword')`;
    for (const query of ["STRINGx", "yz_100", "100%", "SUB%done", "sub_string", "S", "su", " ", "100\\%"]) {
      const result = await listPaged({ notebookId: notebook.id, query, pagination: { limit: 100, offset: 0 } });
      const [expected] = await sql<
        { matches: boolean }[]
      >`SELECT title ILIKE ${`%${query.trim()}%`} AS matches FROM notebooks.notes WHERE id = ${id}::uuid`;
      expect(result.items.some((note) => note.id === id)).toBe(expected!.matches);
    }
    expect((await listPaged({ notebookId: notebook.id, query: "partialw" })).items.some((note) => note.id === id)).toBe(true);
    expect((await listPaged({ notebookId: notebook.id, query: "rtialword" })).items.some((note) => note.id === id)).toBe(false);
  } finally {
    await sql`DELETE FROM notebooks.notes WHERE id = ${id}::uuid`;
  }
});

postgresTest("append uses indexed extrema for empty, alphabetical, mixed and hand-ordered levels", async () => {
  const notebook = fixtures[1]!;
  await sql.begin(async (tx) => {
    expect((await appendPositionQuery(tx, notebook.id, notebook.folder.id))[0]!.position).toBe(0);
  });
  // This is the exact aggregate used under lockTree by create and move.
  await sql.begin(async (tx) => {
    await indexedPlan(appendPositionQuery(tx, notebook.id, notebook.folder.id), ["idx_notes_notebook_parent_position"], tx);
  });
  const created = spyOn(workspaceEvents, "noteCreated").mockResolvedValue(undefined);
  const updated = spyOn(workspaceEvents, "noteUpdated").mockResolvedValue(undefined);
  const ids: string[] = [];
  try {
    const result = await create({
      data: { notebookId: notebook.id, parentId: notebook.folder.id, contentMd: "# Guard append" },
      creatorId: null,
    });
    expect(result.ok && result.data.position).toBe(0);
    if (!result.ok) throw new Error(result.error);
    ids.push(result.data.id);
    await sql`UPDATE notebooks.notes SET position = 19 WHERE id = ${result.data.id}::uuid`;
    const next = await create({
      data: { notebookId: notebook.id, parentId: notebook.folder.id, contentMd: "# Guard second" },
      creatorId: null,
    });
    expect(next.ok && next.data.position).toBe(20);
    if (!next.ok) throw new Error(next.error);
    ids.push(next.data.id);
    const moved = await move({ id: next.data.id, parentId: result.data.id, locale: "en" });
    expect(moved.ok && moved.data.position).toBe(0);
    await sql`UPDATE notebooks.notes SET position = -3 WHERE id = ${next.data.id}::uuid`;
    const appended = await create({
      data: { notebookId: notebook.id, parentId: result.data.id, contentMd: "# Negative legacy position" },
      creatorId: null,
    });
    expect(appended.ok && appended.data.position).toBe(1);
    if (appended.ok) ids.push(appended.data.id);
  } finally {
    for (const id of ids) await sql`DELETE FROM notebooks.notes WHERE id = ${id}::uuid`;
    created.mockRestore();
    updated.mockRestore();
  }
});

postgresTest("delete and version-retention foreign keys have targeted indexes", async () => {
  const noteId = fixtures[1]!.page.id;
  await indexedPlan(sql`SELECT note_id FROM notebooks.note_favorites WHERE note_id = ${noteId}::uuid`, ["idx_note_favorites_note"]);
  await indexedPlan(sql`SELECT note_version_id FROM notebooks.activity_events WHERE note_version_id = ${noteId}::uuid`, [
    "idx_notebooks_activity_version",
  ]);
});

postgresTest("a prepared generic full-text predicate remains GIN-indexable", async () => {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    await tx.unsafe(
      "PREPARE notebooks_serverguard(text) AS SELECT id FROM notebooks.notes WHERE search_document @@ websearch_to_tsquery('simple', $1)",
    );
    try {
      const [row] = await tx.unsafe<{ "QUERY PLAN": { Plan: Plan }[] }[]>(
        "EXPLAIN (FORMAT JSON) EXECUTE notebooks_serverguard('serverguarduniqueneedle')",
      );
      expect(nodes(row!["QUERY PLAN"][0]!.Plan).some((node) => node["Index Name"] === "idx_notes_search_document")).toBe(true);
    } finally {
      await tx.unsafe("DEALLOCATE notebooks_serverguard");
    }
  });
});

postgresTest("relative create walks existing ancestors and creates only missing parents", async () => {
  const notebook = fixtures[0]!;
  const published = spyOn(workspaceEvents, "noteCreated").mockResolvedValue(undefined);
  const paths = buildNotePaths(notebook.notes, { mirror: false });
  const path = `${paths.get(notebook.folder.id)}/guard-child/guard-grandchild/new-page`;
  try {
    const result = await createAtPath({
      notebookId: notebook.id,
      parentId: notebook.folder.id,
      parentPath: "Guard child/Guard grandchild",
      createParents: true,
      contentMd: "# New page",
      creatorId: null,
    });
    expect(result.ok).toBe(true);
    const resolved = await resolvePath({ notebookId: notebook.id, path });
    expect(resolved.ok && resolved.note.id).toBe(result.ok && result.note.id);
  } finally {
    await sql`DELETE FROM notebooks.notes WHERE notebook_id = ${notebook.id}::uuid
      AND parent_id = ${notebook.folder.id}::uuid AND title = 'Guard child'`;
    published.mockRestore();
  }
});

postgresTest("batched reindex preserves reference membership and reports progress per note", async () => {
  const notebook = fixtures[0]!;
  const before = await sql<{ note_id: string; tag: string }[]>`SELECT note_id, tag FROM notebooks.note_tags
    WHERE notebook_id = ${notebook.id}::uuid ORDER BY note_id, tag`;
  let progress = 0;
  expect(
    await reindexNotebook({
      notebookId: notebook.id,
      onProgress: async () => {
        progress += 1;
      },
    }),
  ).toEqual({ notes: 13, failed: 0 });
  expect(progress).toBe(13);
  const after = await sql<{ note_id: string; tag: string }[]>`SELECT note_id, tag FROM notebooks.note_tags
    WHERE notebook_id = ${notebook.id}::uuid ORDER BY note_id, tag`;
  expect(after).toEqual(before);
});

postgresTest("created-time and tag-only filters start from their indexes", async () => {
  const notebook = fixtures[1]!;
  const latest = await searchInNotebook({ notebookId: notebook.id, filters: {}, pagination });
  const at = latest.hits[0]!.note.createdAt;
  const dates = normalizeFilters({ createdAfter: at, createdBefore: at });
  await indexedPlan(
    searchPageQuery({
      filters: dates,
      condition: sql`n.notebook_id = ${notebook.id}::uuid AND ${searchCondition(dates, notebook.id)}`,
      pagination,
      backend: "native",
    }),
    ["idx_notes_notebook_created"],
  );
  await indexedPlan(searchPageQuery({ filters: dates, condition: searchCondition(dates), pagination, backend: "native" }), [
    "idx_notes_created",
  ]);
  for (const notebookId of [notebook.id, undefined]) {
    const filters = normalizeFilters({ tags: ["server-guard-no-such-tag"] });
    await indexedPlan(
      searchPageQuery({
        filters,
        condition: sql`${notebookId ? sql`n.notebook_id = ${notebookId}::uuid` : sql`true`} AND ${searchCondition(filters, notebookId)}`,
        pagination,
        backend: "native",
      }),
      [notebookId ? "idx_note_tags_nb_tag" : "idx_note_tags_tag_note"],
    );
  }
  expect(await searchInNotebook({ notebookId: notebook.id, filters: { tags: ["server-guard-no-such-tag"] }, pagination })).toEqual({
    hits: [],
    total: 0,
  });
});

postgresTest("a title that starts with a capital umlaut resolves by its address, whatever the database locale", async () => {
  const notebook = fixtures[0]!;
  const parent = notebook.notes.find((note) => note.id === notebook.folder.id)!;
  const parentPath = buildNotePaths(notebook.notes, { mirror: false }).get(parent.id)!;
  const id = crypto.randomUUID();
  const shortId = testShortId();
  try {
    await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, parent_id, title, content_md) VALUES
      (${id}::uuid, ${shortId}, ${notebook.id}::uuid, ${parent.id}::uuid, 'Übersicht Ärger', '# Übersicht Ärger')`;
    expect(noteSlug("Übersicht Ärger")).toBe("uebersicht-aerger");
    const result = await resolvePath({ notebookId: notebook.id, path: `${parentPath}/uebersicht-aerger` });
    expect(result.ok && result.note.shortId).toBe(shortId);
  } finally {
    await sql`DELETE FROM notebooks.notes WHERE id = ${id}::uuid`;
  }
});
