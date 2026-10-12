import { expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { z } from "zod";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";

const PublicNoteSchema = z.object({
  id: z.string(),
  notebookId: z.string(),
  parentId: z.string().nullable(),
  contentMd: z.string().nullable(),
  title: z.string(),
});
const RestoreResponseSchema = z.object({
  note: PublicNoteSchema,
  changed: z.boolean(),
  previousVersionId: z.string().nullable(),
  versionId: z.string().nullable(),
});

if (process.env.NOTEBOOKS_VERSION_RESTORE_CHILD !== "1") {
  testFor("database", "nats")(
    "version restore preserves live content for undo and creates exact copies through HTTP",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_VERSION_RESTORE_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    },
    60_000,
  );
} else {
  test("live restore, undo, permissions and exact-content copies", async () => {
    const Y = await import("yjs");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("../migrate");
    const { notebooksService } = await import("../service");
    const { createYjsTopic, NODE_ID, toBase64 } = await import("../service/yjs-sync");
    const { default: app } = await import("./index");
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("notebooks-version-restore");
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const makeUser = (name: string): User => ({
      id: crypto.randomUUID(),
      uid: `restore-${name}-${crypto.randomUUID().slice(0, 8)}`,
      roles: [],
      provider: "local",
      profile: "user",
      givenname: name,
      sn: "Restore",
      displayName: name,
      mail: `${name}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    });
    const writer = makeUser("writer");
    const reader = makeUser("reader");
    let currentUser = writer;
    spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async () => ({ kind: "user", payload: {}, user: currentUser, scopes: [] }));
    const notebookId = crypto.randomUUID();
    const notebookShortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const headers = { authorization: "Bearer version-restore" };
    const live = new AbortController();
    const doc = new Y.Doc();
    const accessIds: string[] = [];
    const encode = (content: string) => {
      const versionDoc = new Y.Doc();
      try {
        versionDoc.getText("codemirror").insert(0, content);
        return Buffer.from(Y.encodeStateAsUpdate(versionDoc));
      } finally {
        versionDoc.destroy();
      }
    };
    const addVersion = async (noteId: string, content: string, storedMarkdown: string | null = content) => {
      const [version] = await sql<{ id: string }[]>`
        INSERT INTO notebooks.note_versions (note_id, yjs_snapshot, content_md, created_at)
        VALUES (${noteId}::uuid, ${encode(content)}, ${storedMarkdown}, now() - interval '1 hour') RETURNING id
      `;
      if (!version) throw new Error("Missing version fixture");
      return version.id;
    };
    const createNote = async (contentMd: string, parentId?: string, position?: number) => {
      const result = await notebooksService.note.create({ data: { notebookId, contentMd, parentId, position }, creatorId: writer.id });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const versionPath = (noteShortId: string, versionId: string) => `/${notebookShortId}/notes/${noteShortId}/versions/${versionId}`;
    const post = (path: string, locale = "en") => app.request(path, { method: "POST", headers: { ...headers, "accept-language": locale } });
    try {
      await sync.ready();
      await migrate();
      for (const [user, permission] of [
        [writer, "write"],
        [reader, "read"],
      ] as const) {
        await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
        const [access] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access (user_id, permission) VALUES (${user.id}::uuid, ${permission}) RETURNING id`;
        if (!access) throw new Error("Missing access fixture");
        accessIds.push(access.id);
      }
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Version restore')`;
      for (const accessId of accessIds)
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${accessId}::uuid)`;

      const initialText = "# Live title\n\n#live-only\n";
      const versionText = "# Restored title\n\n#version-only\n\n@meta\n:::data\nstatus: restored\n:::";
      const note = await createNote(initialText);
      const versionId = await addVersion(note.id, versionText);
      const anchored = await notebooksService.note.getAnchoredYjsState({ noteId: note.id });
      if (!anchored?.yjsState || !anchored.streamCursor) throw new Error("Missing anchored state");
      Y.applyUpdate(doc, anchored.yjsState);
      const topic = createYjsTopic();
      const subscription = topic.hub({ tenantId: note.id }).subscribe({ after: anchored.streamCursor, signal: live.signal });
      const receivedActors: Array<{ kind: string; id: string } | undefined> = [];
      const receiving = (async () => {
        for await (const event of subscription) {
          if (event.data.originPeerId !== "browser") {
            receivedActors.push(event.data.actor);
            Y.applyUpdate(doc, Buffer.from(event.data.payload, "base64"), "remote");
          }
        }
      })();
      const snapshot = await notebooksService.note.save({
        noteId: note.id,
        yjsState: Y.encodeStateAsUpdate(doc),
        contentMd: initialText,
        createdBy: reader.id,
        createVersion: true,
      });
      expect(snapshot.ok).toBe(true);
      const vector = Y.encodeStateVector(doc);
      const text = doc.getText("codemirror");
      text.insert(text.length, "unsnapshotted 😀\n");
      await topic.publish({
        tenantId: note.id,
        data: {
          kind: "sync",
          payload: toBase64(Y.encodeStateAsUpdate(doc, vector)),
          originNodeId: NODE_ID,
          originPeerId: "browser",
          actor: { kind: "user", id: reader.id },
        },
      });
      const liveText = text.toString();
      expect((await notebooksService.note.get({ id: note.id }))?.contentMd).toBe(initialText);
      await notebooksService.activity.record({
        notebookId,
        noteId: note.id,
        actor: { kind: "user", id: reader.id },
        action: "note.edited",
      });
      const activitiesBefore =
        await sql`SELECT * FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'note.edited' ORDER BY id`;
      const response = await post(`${versionPath(note.shortId, versionId)}/restore`);
      const restored = RestoreResponseSchema.parse(await response.json());
      expect({ status: response.status, body: restored }).toMatchObject({
        status: 200,
        body: { changed: true, note: { id: note.shortId, notebookId: notebookShortId, contentMd: versionText, title: "Restored title" } },
      });
      expect(restored.previousVersionId).toEqual(expect.any(String));
      expect(restored.versionId).toEqual(expect.any(String));
      if (!restored.previousVersionId || !restored.versionId) throw new Error("Missing restore version IDs");
      const versions = await sql<
        { id: string; content_md: string; created_by: string | null; yjs_snapshot: Buffer; created_at: Date }[]
      >`SELECT id, content_md, created_by, yjs_snapshot, created_at FROM notebooks.note_versions WHERE note_id = ${note.id}::uuid ORDER BY created_at`;
      const previous = versions.find((row) => row.id === restored.previousVersionId);
      const restoreVersion = versions.find((row) => row.id === restored.versionId);
      expect(previous).toMatchObject({ content_md: liveText, created_by: null });
      expect(restoreVersion).toMatchObject({ content_md: versionText, created_by: writer.id });
      if (!previous || !restoreVersion) throw new Error("Missing persisted versions");
      expect(restoreVersion.created_at.getTime() - previous.created_at.getTime()).toBeLessThan(5 * 60_000);
      const previousDoc = new Y.Doc();
      try {
        Y.applyUpdate(previousDoc, new Uint8Array(previous.yjs_snapshot));
        expect(previousDoc.getText("codemirror").toString()).toBe(liveText);
      } finally {
        previousDoc.destroy();
      }
      expect(
        await sql<
          { actor_kind: string; actor_id: string }[]
        >`SELECT actor_kind, actor_id FROM notebooks.note_version_contributors WHERE version_id = ${restored.previousVersionId}::uuid`,
      ).toEqual([{ actor_kind: "user", actor_id: reader.id }]);
      expect(
        await sql<
          { actor_kind: string; actor_id: string }[]
        >`SELECT actor_kind, actor_id FROM notebooks.note_version_contributors WHERE version_id = ${restored.versionId}::uuid`,
      ).toEqual([{ actor_kind: "user", actor_id: writer.id }]);
      expect(
        await sql`SELECT * FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'note.edited' ORDER BY id`,
      ).toEqual(activitiesBefore);
      expect(
        await sql<
          { actor_kind: string; actor_id: string; note_version_id: string }[]
        >`SELECT actor_kind, actor_id, note_version_id FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'note.restored'`,
      ).toEqual([{ actor_kind: "user", actor_id: writer.id, note_version_id: restored.versionId }]);
      expect(await sql<{ tag: string }[]>`SELECT tag FROM notebooks.note_tags WHERE note_id = ${note.id}::uuid`).toEqual([
        { tag: "version-only" },
      ]);
      expect(
        await sql<{ revision: string }[]>`SELECT yjs_restore_revision::text AS revision FROM notebooks.notes WHERE id = ${note.id}::uuid`,
      ).toEqual([{ revision: anchored.restoreRevision }]);
      const deadline = Date.now() + 5_000;
      while (text.toString() !== versionText && Date.now() < deadline) await Bun.sleep(20);
      expect(text.toString()).toBe(versionText);
      expect(receivedActors).toContainEqual({ kind: "user", id: writer.id });

      const beforeNoop = await sql`SELECT * FROM notebooks.notes WHERE id = ${note.id}::uuid`;
      const cursorBeforeNoop = await topic.latestCursor({ tenantId: note.id });
      expect(await (await post(`${versionPath(note.shortId, versionId)}/restore`)).json()).toMatchObject({
        changed: false,
        previousVersionId: null,
        versionId: null,
      });
      expect(await sql`SELECT * FROM notebooks.notes WHERE id = ${note.id}::uuid`).toEqual(beforeNoop);
      expect(await topic.latestCursor({ tenantId: note.id })).toBe(cursorBeforeNoop);
      expect(await sql`SELECT id FROM notebooks.note_versions WHERE note_id = ${note.id}::uuid`).toHaveLength(versions.length);
      expect(
        await sql`SELECT id FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'note.restored'`,
      ).toHaveLength(1);

      const undoneResponse = await post(`${versionPath(note.shortId, restored.previousVersionId)}/restore`);
      expect(undoneResponse.status).toBe(200);
      expect(await undoneResponse.json()).toMatchObject({
        changed: true,
        previousVersionId: restored.versionId,
        note: { contentMd: liveText, title: "Live title" },
      });
      expect(await sql<{ tag: string }[]>`SELECT tag FROM notebooks.note_tags WHERE note_id = ${note.id}::uuid`).toEqual([
        { tag: "live-only" },
      ]);
      // Direct service callers also decode legacy versions and force the five-minute interval.
      await sql`UPDATE notebooks.note_versions SET content_md = NULL WHERE id = ${versionId}::uuid`;
      const direct = await notebooksService.note.versions.restoreInPlace({
        noteId: note.id,
        versionId,
        createdBy: writer.id,
        actor: { kind: "user", id: writer.id },
      });
      if (!direct.ok) throw new Error(direct.error);
      expect(direct.data.changed).toBe(true);
      expect(
        await sql<
          { content_md: string; created_by: string | null }[]
        >`SELECT content_md, created_by FROM notebooks.note_versions WHERE id = ${direct.data.versionId}::uuid`,
      ).toEqual([{ content_md: versionText, created_by: writer.id }]);
      live.abort();
      await receiving;

      expect(
        await sql<
          { data_properties: { meta: { status: string } } }[]
        >`SELECT data_properties FROM notebooks.notes WHERE id = ${note.id}::uuid`,
      ).toEqual([{ data_properties: { meta: { status: "restored" } } }]);

      const parent = await createNote("# Parent");
      const first = await createNote("# First", parent.id, 0);
      const original = await createNote("# Original\n\nkeep this\n", parent.id, 1);
      const last = await createNote("# Last", parent.id, 2);
      const originalBefore = await notebooksService.note.getWithContent({ id: original.id });
      const copyText = "plain text without an H1\n\n#copied\n";
      const copyVersionId = await addVersion(original.id, copyText, null);
      const copyResponse = await post(`${versionPath(original.shortId, copyVersionId)}/copy`);
      expect(copyResponse.status).toBe(200);
      const copy = PublicNoteSchema.parse(await copyResponse.json());
      expect(copy).toMatchObject({ parentId: parent.shortId, contentMd: copyText, title: "plain text without an H1" });
      expect(await notebooksService.note.getWithContent({ id: original.id })).toEqual(originalBefore);
      expect(
        await sql<{ short_id: string }[]>`SELECT short_id FROM notebooks.notes WHERE parent_id = ${parent.id}::uuid ORDER BY position`,
      ).toEqual([first.shortId, original.shortId, copy.id, last.shortId].map((short_id) => ({ short_id })));
      const emptyVersionId = await addVersion(original.id, "");
      const emptyCopy = await post(`${versionPath(original.shortId, emptyVersionId)}/copy`);
      expect(emptyCopy.status).toBe(200);
      expect(await emptyCopy.json()).toMatchObject({ contentMd: "" });

      currentUser = reader;
      for (const action of ["restore", "copy"])
        expect((await post(`${versionPath(original.shortId, copyVersionId)}/${action}`)).status).toBe(403);
      currentUser = writer;
      await sql`UPDATE notebooks.notes SET locked_at = now() WHERE id = ${original.id}::uuid`;
      const lockedBefore = await notebooksService.note.getWithContent({ id: original.id });
      const locked = await post(`${versionPath(original.shortId, copyVersionId)}/restore`);
      expect(locked.status).toBe(403);
      expect(await locked.json()).toMatchObject({ message: "Cannot restore locked note" });
      const lockedCopy = await post(`${versionPath(original.shortId, copyVersionId)}/copy`);
      expect(lockedCopy.status).toBe(200);
      expect(await lockedCopy.json()).toMatchObject({ contentMd: copyText });
      expect(await notebooksService.note.getWithContent({ id: original.id })).toEqual(lockedBefore);
      for (const action of ["restore", "copy"]) {
        const wrongNote = await post(`${versionPath(first.shortId, copyVersionId)}/${action}`, "de");
        expect(wrongNote.status).toBe(404);
        expect(await wrongNote.json()).toMatchObject({ message: "Version nicht gefunden" });
        expect((await post(`${versionPath(first.shortId, crypto.randomUUID())}/${action}`)).status).toBe(404);
        expect((await post(`${versionPath("absent", copyVersionId)}/${action}`)).status).toBe(404);
      }
    } finally {
      live.abort();
      doc.destroy();
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      for (const user of [writer, reader]) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  }, 30_000);
}
