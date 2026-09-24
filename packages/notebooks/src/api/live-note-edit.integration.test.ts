import { expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { natsServers, testFor } from "../../../../scripts/fixtures/test-infra";

/**
 * An agent reads and edits a note through the CLI's HTTP routes while the note
 * is open in the browser editor with edits that no snapshot covers yet. The
 * read must show the live content, so its hash is a valid edit precondition.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.NOTEBOOKS_LIVE_EDIT_CHILD !== "1") {
  testFor("database", "nats")(
    "the CLI reads and edits a note that is open in the editor",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, NOTEBOOKS_LIVE_EDIT_CHILD: "1" },
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
  test("live read and conditional edit", async () => {
    const Y = await import("yjs");
    const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const { createSync } = await import("@k2b/sync");
    const { connect } = await import("@nats-io/transport-node");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("../migrate");
    const { notebooksService } = await import("../service");
    const { createYjsTopic, NODE_ID, toBase64 } = await import("../service/yjs-sync");
    const { noteContentHash } = await import("../lib/note-edit");
    const { default: app } = await import("./index");

    const connection = await connect({ servers: natsServers() });
    const namespace = `notebooks-live-edit-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const user: User = {
      id: crypto.randomUUID(),
      uid: `live-edit-${crypto.randomUUID().slice(0, 8)}`,
      roles: ["admin"],
      provider: "local",
      profile: "user",
      givenname: "Live",
      sn: "Editor",
      displayName: "Live Editor",
      mail: "live-edit@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    const notebookId = crypto.randomUUID();
    const notebookShortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const live = new AbortController();
    const doc = new Y.Doc();
    try {
      await sync.ready();
      await migrate();
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Live edit')`;
      const created = await notebooksService.note.create({ data: { notebookId, contentMd: "# Plan\n\nfirst\n" }, creatorId: user.id });
      if (!created.ok) throw new Error(created.error);
      const noteId = created.data.id;
      const path = `/${notebookShortId}/notes/${created.data.shortId}/content`;
      const headers = { authorization: "Bearer live-edit", "content-type": "application/json" };
      const read = async () => {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(200);
        return (await response.json()) as { contentMd: string; yjsSnapshot: string };
      };

      // The open editor: stored snapshot, live subscription, and publishes shaped like ws.ts.
      Y.applyUpdate(doc, Buffer.from((await read()).yjsSnapshot, "base64"), "initial");
      const anchored = await notebooksService.note.getAnchoredYjsState({ noteId });
      const topic = createYjsTopic();
      const subscription = topic.hub({ tenantId: noteId }).subscribe({ after: anchored!.streamCursor!, signal: live.signal });
      void (async () => {
        for await (const event of subscription) {
          if (event.data.originPeerId !== "browser") Y.applyUpdate(doc, Buffer.from(event.data.payload, "base64"), "remote");
        }
      })().catch(() => undefined);
      const typed = new Promise<void>((resolve, reject) => {
        doc.once("update", (update: Uint8Array) => {
          topic
            .publish({
              tenantId: noteId,
              data: {
                kind: "sync",
                payload: toBase64(update),
                originNodeId: NODE_ID,
                originPeerId: "browser",
                actor: { kind: "user", id: user.id },
              },
            })
            .then(() => resolve(), reject);
        });
      });
      const text = doc.getText("codemirror");
      text.insert(text.length, "typed in browser\n");
      await typed;

      // `cld notebooks read` sees the unsnapshotted edit, so its hash guards the next edit.
      const current = await read();
      expect(current.contentMd).toBe("# Plan\n\nfirst\ntyped in browser\n");
      const response = await app.request(path, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          operations: [{ kind: "append", content: "from agent\n" }],
          ifContentHash: noteContentHash(current.contentMd),
        }),
      });
      expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { changed: true } });

      const expected = "# Plan\n\nfirst\ntyped in browser\nfrom agent\n";
      expect((await read()).contentMd).toBe(expected);
      const deadline = Date.now() + 5_000;
      while (text.toString() !== expected && Date.now() < deadline) await Bun.sleep(20);
      expect(text.toString()).toBe(expected);
    } finally {
      live.abort();
      doc.destroy();
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
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
