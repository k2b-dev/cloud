import { afterAll, beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { create, get, getTree, list, move, type Note, type NotePlacement, resetOrder, update } from "./notes";
import * as workspaceEvents from "./workspace-events";

const postgresTest = testFor("database");
const notebookIds: string[] = [];
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

afterAll(async () => {
  if (!testInfra.database) return;
  for (const id of notebookIds) await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
});

const notebook = async () => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${id}::uuid, ${shortId()}, 'Note order test')`;
  notebookIds.push(id);
  return id;
};

const withNotebook = async (run: (notebookId: string) => Promise<void>) => {
  const created = spyOn(workspaceEvents, "noteCreated").mockResolvedValue(undefined);
  const updated = spyOn(workspaceEvents, "noteUpdated").mockResolvedValue(undefined);
  const invalidated = spyOn(workspaceEvents, "invalidated").mockResolvedValue(undefined);
  try {
    await run(await notebook());
  } finally {
    created.mockRestore();
    updated.mockRestore();
    invalidated.mockRestore();
  }
};

const newNote = async (notebookId: string, title: string, parentId?: string, position?: number): Promise<Note> => {
  const result = await create({ data: { notebookId, parentId, position, contentMd: `# ${title}` }, creatorId: null, locale: "en" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

const placed = async (id: string, placement: NotePlacement, parentId?: string | null): Promise<Note> => {
  const result = await move({ id, parentId, placement, locale: "en" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

const level = async (notebookId: string, parentId: string | null = null) => {
  const nodes = await getTree({ notebookId, locale: "en" });
  const find = (nodes: Awaited<ReturnType<typeof getTree>>): Awaited<ReturnType<typeof getTree>> | undefined => {
    if (parentId === null) return nodes;
    for (const node of nodes) {
      if (node.id === parentId) return node.children;
      const children = find(node.children);
      if (children) return children;
    }
    return undefined;
  };
  return find(nodes) ?? [];
};

const expectOrder = async (notebookId: string, ids: string[], parentId: string | null = null) => {
  const notes = await level(notebookId, parentId);
  expect(notes.map((note) => note.id)).toEqual(ids);
  expect(notes.map((note) => note.position)).toEqual(ids.map((_, index) => index + 1));
};

postgresTest("defaults to alphabetical order with numeric collation and public ID ties", async () =>
  withNotebook(async (notebookId) => {
    const ten = await newNote(notebookId, "Chapter 10");
    const two = await newNote(notebookId, "Chapter 2");
    const one = await newNote(notebookId, "Chapter 1");
    const same = await newNote(notebookId, "Chapter 2");
    const tied = [two, same].sort((a, b) => (a.shortId < b.shortId ? -1 : 1));
    const notes = await level(notebookId);
    expect(notes.map((note) => note.id)).toEqual([one.id, ...tied.map((note) => note.id), ten.id]);
    expect(notes.every((note) => note.position === 0)).toBe(true);
  }),
);

postgresTest("places before, after, first, last, and at a clamped index without changing other levels or edit timestamps", async () =>
  withNotebook(async (notebookId) => {
    const a = await newNote(notebookId, "A");
    const b = await newNote(notebookId, "B");
    const c = await newNote(notebookId, "C");
    const child = await newNote(notebookId, "Child", a.id);
    const updatedAt = new Map((await list({ notebookId })).map((note) => [note.id, note.updatedAt]));
    const published = spyOn(workspaceEvents, "noteUpdated").mockImplementation(async (note) => {
      // The event observes committed positions, including the siblings.
      expect((await get({ id: note.id }))?.position).toBeGreaterThan(0);
      expect((await level(notebookId)).map((note) => note.position)).toEqual([1, 2, 3]);
    });
    await placed(c.id, { before: b.id });
    await expectOrder(notebookId, [a.id, c.id, b.id]);
    await placed(a.id, { after: c.id });
    await expectOrder(notebookId, [c.id, a.id, b.id]);
    await placed(b.id, { position: "first" });
    await expectOrder(notebookId, [b.id, c.id, a.id]);
    await placed(b.id, { position: "last" });
    await expectOrder(notebookId, [c.id, a.id, b.id]);
    await placed(b.id, { position: 1 });
    await expectOrder(notebookId, [c.id, b.id, a.id]);
    await placed(c.id, { position: 999 });
    await expectOrder(notebookId, [b.id, a.id, c.id]);
    expect(published).toHaveBeenCalledTimes(6);
    expect((await get({ id: child.id }))?.position).toBe(0);
    expect((await get({ id: a.id }))?.hasChildren).toBe(true);
    for (const note of await list({ notebookId })) expect(note.updatedAt).toBe(updatedAt.get(note.id)!);
  }),
);

postgresTest("reparents without placement using the target mode, preserves source gaps, and appends new notes", async () =>
  withNotebook(async (notebookId) => {
    const hand = await newNote(notebookId, "Hand");
    const alpha = await newNote(notebookId, "Alphabetical");
    const a = await newNote(notebookId, "A", hand.id);
    const b = await newNote(notebookId, "B", hand.id);
    const c = await newNote(notebookId, "C", alpha.id);
    await placed(b.id, { position: "first" });
    const moved = await move({ id: c.id, parentId: hand.id, locale: "en" });
    expect(moved.ok).toBe(true);
    await expectOrder(notebookId, [b.id, a.id, c.id], hand.id);
    const beforeMove = (await get({ id: b.id }))!;
    // Set a distinct timestamp to make the parent-change check independent of clock precision.
    await sql`UPDATE notebooks.notes SET updated_at = '2000-01-01'::timestamptz WHERE id = ${b.id}::uuid`;
    const alphabetical = await move({ id: b.id, parentId: alpha.id, locale: "en" });
    expect(alphabetical.ok && alphabetical.data.position).toBe(0);
    expect(alphabetical.ok && alphabetical.data.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect((await get({ id: a.id }))?.position).toBe(2);
    expect((await get({ id: c.id }))?.position).toBe(3);
    const appended = await newNote(notebookId, "Z", hand.id);
    expect(appended.position).toBe(4);
    expect((await newNote(notebookId, "D", alpha.id)).position).toBe(0);
    const unchanged = await get({ id: a.id });
    expect(await move({ id: a.id, locale: "en" })).toEqual({ ok: true, data: unchanged! });
    expect(beforeMove.parentId).toBe(hand.id);
  }),
);

postgresTest("create with position renumbers, PATCH shares placement semantics, and reset only affects its level", async () =>
  withNotebook(async (notebookId) => {
    const parent = await newNote(notebookId, "Parent");
    const a = await newNote(notebookId, "A", parent.id);
    const b = await newNote(notebookId, "B", parent.id);
    const c = await newNote(notebookId, "C", parent.id, 1);
    await expectOrder(notebookId, [a.id, c.id, b.id], parent.id);
    const d = await newNote(notebookId, "D", parent.id, 999);
    await expectOrder(notebookId, [a.id, c.id, b.id, d.id], parent.id);
    expect((await update({ id: d.id, data: { position: 0 }, locale: "en" })).ok).toBe(true);
    await expectOrder(notebookId, [d.id, a.id, c.id, b.id], parent.id);
    await placed(parent.id, { position: "first" });
    const invalidated = spyOn(workspaceEvents, "invalidated").mockResolvedValue(undefined);
    expect((await resetOrder({ notebookId, parentId: parent.id })).ok).toBe(true);
    expect((await level(notebookId, parent.id)).map((note) => [note.id, note.position])).toEqual([a, b, c, d].map((note) => [note.id, 0]));
    expect((await get({ id: parent.id }))?.position).toBe(1);
    expect(invalidated).toHaveBeenCalledWith({ notebookId, reason: "bulk", scopes: ["tree"] });
    await resetOrder({ notebookId, parentId: parent.id });
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect((await newNote(notebookId, "E", parent.id)).position).toBe(0);
    await placed(d.id, { position: "first" });
    const children = await level(notebookId, parent.id);
    expect((await resetOrder({ notebookId, parentId: null })).ok).toBe(true);
    expect((await get({ id: parent.id }))?.position).toBe(0);
    expect(await level(notebookId, parent.id)).toEqual(children);
  }),
);

postgresTest("parallel moves and create plus move retain every note with unique contiguous positions", async () =>
  withNotebook(async (notebookId) => {
    const notes: Note[] = [];
    for (let index = 0; index < 8; index++) notes.push(await newNote(notebookId, `Note ${index}`));
    const moved = await Promise.all(notes.map((note, index) => move({ id: note.id, placement: { position: index % 3 }, locale: "en" })));
    expect(moved.every((result) => result.ok)).toBe(true);
    const ordered = await level(notebookId);
    expect(ordered.map((note) => note.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(ordered.map((note) => note.id))).toEqual(new Set(notes.map((note) => note.id)));
    const [created, changed] = await Promise.all([
      newNote(notebookId, "New"),
      move({ id: notes[0]!.id, placement: { position: "last" }, locale: "en" }),
    ]);
    expect(changed.ok).toBe(true);
    const afterCreate = await level(notebookId);
    expect(afterCreate.map((note) => note.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(afterCreate.map((note) => note.id))).toEqual(new Set([...notes.map((note) => note.id), created.id]));
    await Promise.all([newNote(notebookId, "Placed new", undefined, 0), placed(notes[1]!.id, { position: "first" })]);
    expect((await level(notebookId)).map((note) => note.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }),
);

postgresTest("locked siblings may be ordered but not reparented; invalid anchors, parents, and cycles are rejected", async () =>
  withNotebook(async (notebookId) => {
    const a = await newNote(notebookId, "A");
    const b = await newNote(notebookId, "B");
    const child = await newNote(notebookId, "Child", a.id);
    await sql`UPDATE notebooks.notes SET locked_at = now() WHERE id = ${b.id}::uuid`;
    await placed(b.id, { position: "first" });
    await expectOrder(notebookId, [b.id, a.id]);
    expect(await move({ id: b.id, parentId: a.id, locale: "en" })).toMatchObject({
      ok: false,
      status: 403,
      error: "Cannot modify locked note",
    });
    expect(await move({ id: a.id, placement: { before: a.id }, locale: "en" })).toMatchObject({ ok: false, status: 400 });
    expect(await move({ id: b.id, parentId: null, placement: { before: child.id }, locale: "en" })).toMatchObject({
      ok: false,
      status: 400,
      error: "The anchor note is not in the target level",
    });
    expect(await move({ id: a.id, parentId: child.id, locale: "en" })).toMatchObject({
      ok: false,
      status: 400,
      error: "Cannot move note to be a child of itself",
    });
    expect(await move({ id: a.id, parentId: a.id, locale: "en" })).toMatchObject({ ok: false, status: 400 });
    const other = await newNote(await notebook(), "Other");
    expect(await move({ id: a.id, placement: { after: other.id }, locale: "en" })).toMatchObject({ ok: false, status: 404 });
    expect(await move({ id: a.id, placement: { after: crypto.randomUUID() }, locale: "en" })).toMatchObject({ ok: false, status: 404 });
    expect(await move({ id: a.id, parentId: other.id, locale: "en" })).toMatchObject({ ok: false, status: 404 });
    expect(await resetOrder({ notebookId, parentId: other.id })).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await resetOrder({ notebookId, parentId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { status: 404 } });
    const unlocked = await newNote(notebookId, "Unlocked");
    const placedAtAnchor = await placed(unlocked.id, { after: child.id });
    expect(placedAtAnchor.parentId).toBe(a.id);
    await expectOrder(notebookId, [child.id, unlocked.id], a.id);
  }),
);

postgresTest("the normalization marker preserves a hand order across repeated migrations", async () =>
  withNotebook(async (notebookId) => {
    const a = await newNote(notebookId, "A");
    const b = await newNote(notebookId, "B");
    await placed(b.id, { position: "first" });
    const [marker] = await sql`SELECT name FROM notebooks.data_migrations WHERE name = 'note-order-alphabetical-default'`;
    expect(marker).toBeDefined();
    await migrate();
    await migrate();
    await expectOrder(notebookId, [b.id, a.id]);
  }),
);
