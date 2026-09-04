import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { QueryBlock, QueryFilter } from "../lib/query-blocks";
import { migrate } from "../migrate";
import { resolveNoteQuery } from "./note-query";

const postgresTest = process.env.NOTEBOOKS_DB_TEST === "1" ? test : test.skip;
const id = () => crypto.randomUUID();
const shortId = () => Math.random().toString(36).slice(2, 8).padEnd(6, "x");

const notebookId = id();
const notebookShortId = shortId();
const otherNotebookId = id();
const otherNotebookShortId = shortId();
const accessId = id();
const serviceAccountId = id();
const serviceAccessId = id();
const rootId = id();
const rootShortId = shortId();
const alphaId = id();
const alphaShortId = shortId();
const betaId = id();
const betaShortId = shortId();
const gammaId = id();
const gammaShortId = shortId();
const deltaId = id();
const deltaShortId = shortId();
const tieOneId = id();
const tieOneShortId = shortId();
const tieTwoId = id();
const tieTwoShortId = shortId();
const foreignId = id();

const baseQuery = (overrides: Partial<QueryBlock> = {}): QueryBlock => ({
  source: "notes",
  scope: "notebook",
  match: "all",
  where: [],
  sort: { field: "$title", direction: "asc" },
  columns: ["$title", "meta.status", "meta.priority", "$tags"],
  limit: 100,
  line: 1,
  ...overrides,
});

const resolve = (query: QueryBlock, overrides: { noteId?: string; notebookId?: string } = {}) =>
  resolveNoteQuery({
    notebookId: overrides.notebookId ?? notebookId,
    noteId: overrides.noteId ?? rootId,
    query,
    userId: null,
  });

const titlesFor = async (filter: QueryFilter, match: QueryBlock["match"] = "all") =>
  (await resolve(baseQuery({ where: [filter], match }))).items.map((item) => item.title);

beforeAll(async () => {
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await migrate();
  await sql`
    INSERT INTO notebooks.notebooks (id, short_id, name) VALUES
      (${notebookId}::uuid, ${notebookShortId}, 'Query resolver'),
      (${otherNotebookId}::uuid, ${otherNotebookShortId}, 'Other notebook')
  `;
  await sql`
    INSERT INTO auth.access (id, permission)
    VALUES (${accessId}::uuid, 'read')
  `;
  await sql`
    INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id)
    VALUES (${serviceAccountId}::uuid, 'Query resolver test', 'resource_bound', 'notebooks', 'notebook', ${notebookId})
  `;
  await sql`
    INSERT INTO auth.access (id, service_account_id, permission)
    VALUES (${serviceAccessId}::uuid, ${serviceAccountId}::uuid, 'read')
  `;
  await sql`
    INSERT INTO notebooks.notebook_access (notebook_id, access_id)
    VALUES
      (${notebookId}::uuid, ${accessId}::uuid),
      (${notebookId}::uuid, ${serviceAccessId}::uuid)
  `;
  await sql`
    INSERT INTO notebooks.notes (
      id, short_id, notebook_id, parent_id, title, content_md, data_properties, created_at, updated_at
    ) VALUES
      (${rootId}::uuid, ${rootShortId}, ${notebookId}::uuid, NULL, 'Dashboard', '', '{}'::jsonb, '2026-01-01T10:00:00Z', '2026-02-01T10:00:00Z'),
      (${alphaId}::uuid, ${alphaShortId}, ${notebookId}::uuid, ${rootId}::uuid, 'Alpha Guide', '', ${{ meta: { status: "reviewed", priority: 3, owner: "Ada Lovelace", labels: ["handbook", 3, true] } }}::jsonb, '2026-01-02T10:00:00Z', '2026-02-03T10:00:00Z'),
      (${betaId}::uuid, ${betaShortId}, ${notebookId}::uuid, ${rootId}::uuid, 'beta Guide', '', ${{ meta: { status: "draft", priority: 1, owner: "Bob", labels: ["draft"] } }}::jsonb, '2026-01-03T10:00:00Z', '2026-02-02T10:00:00Z'),
      (${gammaId}::uuid, ${gammaShortId}, ${notebookId}::uuid, ${alphaId}::uuid, 'Gamma', '', ${{ meta: { status: "reviewed", priority: 5, owner: "Ada Team", labels: ["internal", 5] } }}::jsonb, '2026-01-04T10:00:00Z', '2026-02-01T10:00:00Z'),
      (${deltaId}::uuid, ${deltaShortId}, ${notebookId}::uuid, NULL, 'Delta', '', ${{ meta: { priority: "high" } }}::jsonb, '2026-01-05T10:00:00Z', '2026-02-05T10:00:00Z'),
      (${tieOneId}::uuid, ${tieOneShortId}, ${notebookId}::uuid, NULL, 'Tie', '', ${{ meta: { status: "tie", priority: true } }}::jsonb, '2026-01-06T10:00:00Z', '2026-02-06T10:00:00Z'),
      (${tieTwoId}::uuid, ${tieTwoShortId}, ${notebookId}::uuid, NULL, 'Tie', '', ${{ meta: { status: "tie", priority: [4] } }}::jsonb, '2026-01-06T10:00:00Z', '2026-02-06T10:00:00Z'),
      (${foreignId}::uuid, ${shortId()}, ${otherNotebookId}::uuid, ${rootId}::uuid, 'Foreign', '', ${{ meta: { status: "reviewed", priority: 99 } }}::jsonb, '2026-01-07T10:00:00Z', '2026-02-07T10:00:00Z')
  `;
  await sql`
    INSERT INTO notebooks.note_tags (note_id, notebook_id, tag) VALUES
      (${alphaId}::uuid, ${notebookId}::uuid, 'handbook'),
      (${alphaId}::uuid, ${notebookId}::uuid, 'policy'),
      (${betaId}::uuid, ${notebookId}::uuid, 'handbook'),
      (${gammaId}::uuid, ${notebookId}::uuid, 'internal')
  `;
}, 30_000);

afterAll(async () => {
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${otherNotebookId}::uuid)`;
  await sql`DELETE FROM auth.access WHERE id IN (${accessId}::uuid, ${serviceAccessId}::uuid)`;
  await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
}, 30_000);

describe("bounded note query resolver", () => {
  postgresTest("missing properties cannot resolve inherited JavaScript members", async () => {
    const result = await resolve(baseQuery({ columns: ["constructor.name", "meta.constructor", "meta.toString"] }));
    for (const item of result.items) {
      expect(item.values).toEqual({ "constructor.name": null, "meta.constructor": null, "meta.toString": null });
    }
  });

  postgresTest("trusted platform admin queries bypass only ACL, never notebook scope", async () => {
    const input = { notebookId: otherNotebookId, noteId: foreignId, query: baseQuery(), userId: id() };
    expect((await resolveNoteQuery(input)).diagnostics).toEqual([{ code: "unavailable" }]);
    const result = await resolveNoteQuery({ ...input, bypassAccess: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.items.map((item) => item.title)).toEqual(["Foreign"]);
    expect((await resolveNoteQuery({ ...input, bypassAccess: true, noteId: rootId })).diagnostics).toEqual([{ code: "unavailable" }]);
    expect((await resolveNoteQuery({ ...input, bypassAccess: true, boundNotebookId: notebookId })).diagnostics).toEqual([
      { code: "unavailable" },
    ]);
  });

  postgresTest("enforces notebook access and validates the context note for every scope", async () => {
    await sql`
      DELETE FROM notebooks.notebook_access
      WHERE notebook_id = ${notebookId}::uuid AND access_id = ${accessId}::uuid
    `;
    try {
      const denied = await resolve(baseQuery());
      expect(denied).toMatchObject({ items: [], diagnostics: [{ code: "unavailable" }] });
      const resourceAccount = await resolveNoteQuery({
        notebookId,
        noteId: rootId,
        query: baseQuery({ limit: 1 }),
        userId: null,
        serviceAccountId,
        boundNotebookId: notebookId,
      });
      expect(resourceAccount).toMatchObject({ total: 7, diagnostics: [] });
      const wrongBinding = await resolveNoteQuery({
        notebookId,
        noteId: rootId,
        query: baseQuery(),
        userId: null,
        serviceAccountId,
        boundNotebookId: otherNotebookId,
      });
      expect(wrongBinding.diagnostics).toEqual([{ code: "unavailable" }]);
    } finally {
      await sql`
        INSERT INTO notebooks.notebook_access (notebook_id, access_id)
        VALUES (${notebookId}::uuid, ${accessId}::uuid)
        ON CONFLICT DO NOTHING
      `;
    }

    for (const scope of ["notebook", "children", "descendants"] as const) {
      const unavailable = await resolve(baseQuery({ scope }), { noteId: foreignId });
      expect(unavailable).toMatchObject({ items: [], diagnostics: [{ code: "unavailable" }] });
    }
    const unboundServiceAccount = await resolveNoteQuery({
      notebookId,
      noteId: rootId,
      query: baseQuery(),
      userId: null,
      serviceAccountId,
    });
    expect(unboundServiceAccount.diagnostics).toEqual([{ code: "unavailable" }]);
  });

  postgresTest("supports notebook, children, and cycle-safe descendants without crossing notebooks", async () => {
    expect((await resolve(baseQuery({ scope: "children" }))).items.map((item) => item.title)).toEqual(["Alpha Guide", "beta Guide"]);
    expect((await resolve(baseQuery({ scope: "descendants" }))).items.map((item) => item.title)).toEqual([
      "Alpha Guide",
      "beta Guide",
      "Gamma",
    ]);
    const notebook = await resolve(baseQuery({ scope: "notebook" }));
    expect(notebook.total).toBe(7);
    expect(JSON.stringify(notebook)).not.toContain(foreignId);

    try {
      await sql`UPDATE notebooks.notes SET parent_id = ${gammaId}::uuid WHERE id = ${rootId}::uuid`;
      expect((await resolve(baseQuery({ scope: "descendants" }))).items.map((item) => item.title)).toEqual([
        "Alpha Guide",
        "beta Guide",
        "Gamma",
      ]);
    } finally {
      await sql`UPDATE notebooks.notes SET parent_id = NULL WHERE id = ${rootId}::uuid`;
    }
  });

  postgresTest("evaluates exact, membership, existence, text, numeric, and typed-list operators", async () => {
    expect(await titlesFor({ field: "meta.status", op: "eq", value: "reviewed" })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.status", op: "ne", value: "reviewed" })).toEqual(["beta Guide", "Tie", "Tie"]);
    expect(await titlesFor({ field: "meta.status", op: "in", value: ["reviewed", "draft"] })).toEqual([
      "Alpha Guide",
      "beta Guide",
      "Gamma",
    ]);
    expect(await titlesFor({ field: "meta.status", op: "not-in", value: ["draft", "tie"] })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.status", op: "exists" })).toHaveLength(5);
    expect(await titlesFor({ field: "meta.status", op: "missing" })).toEqual(["Dashboard", "Delta"]);
    expect(await titlesFor({ field: "meta.owner", op: "contains", value: "ADA" })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.owner", op: "starts-with", value: "ada" })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.priority", op: "gt", value: 2 })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.priority", op: "gte", value: 3 })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "meta.priority", op: "lt", value: 3 })).toEqual(["beta Guide"]);
    expect(await titlesFor({ field: "meta.priority", op: "lte", value: 1 })).toEqual(["beta Guide"]);
    expect(await titlesFor({ field: "meta.priority", op: "eq", value: 3 })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "meta.priority", op: "in", value: [1, 3] })).toEqual(["Alpha Guide", "beta Guide"]);
    expect(await titlesFor({ field: "meta.labels", op: "contains-any", value: [3, "absent"] })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "meta.labels", op: "contains-all", value: ["handbook", true] })).toEqual(["Alpha Guide"]);
  });

  postgresTest("filters intrinsic fields and tags without duplicating multi-tag notes", async () => {
    expect(await titlesFor({ field: "$title", op: "eq", value: "Alpha Guide" })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "$title", op: "in", value: ["Alpha Guide", "Gamma"] })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "$title", op: "not-in", value: ["Dashboard", "Delta", "Tie", "Alpha Guide", "beta Guide"] })).toEqual([
      "Gamma",
    ]);
    expect(await titlesFor({ field: "$title", op: "contains", value: "GUIDE" })).toEqual(["Alpha Guide", "beta Guide"]);
    expect(await titlesFor({ field: "$title", op: "starts-with", value: "alp" })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "$tags", op: "contains", value: "#HANDBOOK" })).toEqual(["Alpha Guide", "beta Guide"]);
    expect(await titlesFor({ field: "$tags", op: "contains-any", value: ["policy", "internal"] })).toEqual(["Alpha Guide", "Gamma"]);
    expect(await titlesFor({ field: "$tags", op: "contains-all", value: ["handbook", "policy"] })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "$tags", op: "exists" })).toHaveLength(3);
    expect(await titlesFor({ field: "$tags", op: "missing" })).toHaveLength(4);
    expect(await titlesFor({ field: "$created", op: "eq", value: "2026-01-02T10:00:00Z" })).toEqual(["Alpha Guide"]);
    expect(await titlesFor({ field: "$created", op: "in", value: ["2026-01-02T10:00:00Z", "2026-01-04T10:00:00Z"] })).toEqual([
      "Alpha Guide",
      "Gamma",
    ]);
    expect(
      await titlesFor({
        field: "$created",
        op: "not-in",
        value: ["2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z", "2026-01-03T10:00:00Z", "2026-01-05T10:00:00Z", "2026-01-06T10:00:00Z"],
      }),
    ).toEqual(["Gamma"]);
  });

  postgresTest("combines flat any predicates and returns selected values, stable totals, links, and limits", async () => {
    const any = await resolve(
      baseQuery({
        match: "any",
        where: [
          { field: "meta.status", op: "eq", value: "draft" },
          { field: "meta.priority", op: "gte", value: 5 },
        ],
      }),
    );
    expect(any.items.map((item) => item.title)).toEqual(["beta Guide", "Gamma"]);
    const all = await resolve(
      baseQuery({
        where: [
          { field: "meta.status", op: "eq", value: "reviewed" },
          { field: "$tags", op: "contains", value: "handbook" },
        ],
      }),
    );
    expect(all.items.map((item) => item.title)).toEqual(["Alpha Guide"]);

    const limited = await resolve(
      baseQuery({
        where: [{ field: "meta.status", op: "eq", value: "reviewed" }],
        sort: { field: "$updated", direction: "desc" },
        columns: ["$title", "meta.priority", "meta.missing", "$tags"],
        limit: 1,
      }),
    );
    expect(limited).toMatchObject({ total: 2, limit: 1, truncated: true, diagnostics: [] });
    expect(limited.items[0]).toEqual({
      id: alphaShortId,
      href: `/app/notebooks/${notebookShortId}/notes/${alphaShortId}`,
      title: "Alpha Guide",
      values: { $title: "Alpha Guide", "meta.priority": 3, "meta.missing": null, $tags: ["handbook", "policy"] },
    });

    const ties = await resolve(
      baseQuery({ where: [{ field: "meta.status", op: "eq", value: "tie" }], sort: { field: "$updated", direction: "desc" } }),
    );
    const expectedTieIds = [
      { uuid: tieOneId, shortId: tieOneShortId },
      { uuid: tieTwoId, shortId: tieTwoShortId },
    ]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((entry) => entry.shortId);
    expect(ties.items.map((item) => item.id)).toEqual(expectedTieIds);
    expect(JSON.stringify(ties)).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i);

    const createdDesc = await resolve(
      baseQuery({ where: [{ field: "meta.status", op: "eq", value: "reviewed" }], sort: { field: "$created", direction: "desc" } }),
    );
    expect(createdDesc.items.map((item) => item.title)).toEqual(["Gamma", "Alpha Guide"]);
    const updatedAsc = await resolve(
      baseQuery({ where: [{ field: "meta.status", op: "eq", value: "reviewed" }], sort: { field: "$updated", direction: "asc" } }),
    );
    expect(updatedAsc.items.map((item) => item.title)).toEqual(["Gamma", "Alpha Guide"]);
    const titleDesc = await resolve(
      baseQuery({ where: [{ field: "meta.status", op: "eq", value: "reviewed" }], sort: { field: "$title", direction: "desc" } }),
    );
    expect(titleDesc.items.map((item) => item.title)).toEqual(["Gamma", "Alpha Guide"]);
  });
});
