import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { SQL, sql } from "bun";
import { connectTestNats, requireDatabaseUrl, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";

if (process.env.NOTEBOOK_ANNOTATIONS_CHILD !== "1") {
  testFor("database", "nats")(
    "passage comments share service, REST, capability and CLI behavior",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, NOTEBOOK_ANNOTATIONS_CHILD: "1" },
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
    240_000,
  );
} else {
  const { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
  const { createSync } = await import("@k2b/sync");
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const server = await import("@k2b/cloud/server");
  const { migrate } = await import("../migrate");
  const annotations = await import("./annotations");
  const notes = await import("./notes");
  const { notebooksCapabilities, runNotebookActivity } = await import("../capabilities");
  const { ActivityDataSchema, ActivityInputSchema } = await import("../capability-contracts");
  const activity = await import("./activity");
  const { installFirstPartyModules } = await import("../../../cloud-cli/test/fixtures/first-party");
  const notebookId = crypto.randomUUID();
  const notebookShortId = testShortId();
  const identity = (name: string): CapabilityExecutionContext => {
    const id = crypto.randomUUID();
    return {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id,
          name,
          kind: "agent",
          status: "active",
          appId: null,
          resourceType: null,
          resourceId: null,
          delegatedUserId: null,
          createdBy: null,
          createdAt: "2026-10-26T12:00:00.000Z",
        },
        delegatedUser: null,
        scopes: ["read", "write"],
      },
      accessSubject: { type: "service_account", serviceAccountId: id },
      user: null,
      origin: "assistant",
      locale: "en",
      requestId: "annotation-test",
      signal: new AbortController().signal,
    };
  };
  const writer = identity("Review agent");
  const reader = identity("Reader agent");
  const other = identity("Other writer");
  if (other.actor.kind === "service_account") other.actor.serviceAccount.kind = "standalone";
  const user = {
    id: crypto.randomUUID(),
    uid: `review-${crypto.randomUUID().slice(0, 8)}`,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Mara",
    sn: "Keller",
    displayName: "Mara Keller",
    mail: "mara@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  } satisfies import("@k2b/cloud/contracts").User;
  const personContext: CapabilityExecutionContext = {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    user,
    origin: "app",
    locale: "en",
    requestId: "person-review",
    signal: new AbortController().signal,
  };
  const contexts = { writer, reader, other, person: personContext };
  const connection = await connectTestNats();
  const namespace = testSyncNamespace("notebooks-annotations");
  const sync = createSync({ connection, namespace, application: "notebooks", defaults: { replicas: 1 } });
  bindProcessSync(sync);
  let cliHome = "";
  let http: ReturnType<typeof Bun.serve> | undefined;
  let api: typeof import("../api").default;
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-26T21:00:00.000Z"));
  const activeSpies: Array<{ mockRestore(): void }> = [];
  beforeAll(async () => {
    await sync.ready();
    await migrate();
    await sql`INSERT INTO notebooks.notebooks(id, short_id, name) VALUES (${notebookId}::uuid, ${notebookShortId}, 'Review handbook')`;
    for (const [name, context] of Object.entries(contexts)) {
      const who = context.actor;
      if (who.kind === "user") {
        await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${user.id}::uuid, ${user.uid}, 'local', 'user')`;
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access(user_id, permission) VALUES (${user.id}::uuid, 'write') RETURNING id`;
        await sql`INSERT INTO notebooks.notebook_access(notebook_id, access_id) VALUES (${notebookId}::uuid, ${grant!.id}::uuid)`;
        continue;
      }
      await sql`INSERT INTO auth.service_accounts(id, name, kind) VALUES (${who.serviceAccount.id}::uuid, ${who.serviceAccount.name}, ${who.serviceAccount.kind})`;
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(service_account_id, permission) VALUES (${who.serviceAccount.id}::uuid, ${name === "reader" ? "read" : "write"}) RETURNING id`;
      await sql`INSERT INTO notebooks.notebook_access(notebook_id, access_id) VALUES (${notebookId}::uuid, ${grant!.id}::uuid)`;
    }
    activeSpies.push(spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next()));
    activeSpies.push(
      spyOn(server.auth, "requireRole").mockReturnValue(async (c, next) => {
        const key = c.req.header("authorization")?.replace("Bearer ", "") ?? "writer";
        const selected = key === "reader" ? reader : key === "other" ? other : key === "person" ? personContext : writer;
        c.set("actor", selected.actor);
        c.set("accessSubject", selected.accessSubject);
        await next();
      }),
    );
    api = (await import("../api")).default;
    http = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/api\/notebooks/, "") || "/";
        return api.fetch(new Request(url, request));
      },
    });
    cliHome = await mkdtemp(join(tmpdir(), "notebooks-annotations-"));
    await installFirstPartyModules(cliHome, ["notebooks"]);
  }, 60_000);
  afterAll(async () => {
    clock.mockRestore();
    for (const spy of activeSpies) spy.mockRestore();
    http?.stop(true);
    if (cliHome) await rm(cliHome, { recursive: true, force: true });
    try {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
      for (const context of Object.values(contexts))
        if (context.actor.kind === "service_account")
          await sql`DELETE FROM auth.service_accounts WHERE id = ${context.actor.serviceAccount.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await annotations.close();
      await sync.drain();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    } finally {
      unbindProcessSync();
      await connection.close();
    }
  }, 60_000);
  const noteFixture = async (content = "# Handbook\n\nBefore target after\n") => {
    const result = await notes.create({ data: { notebookId, contentMd: content }, creatorId: null });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const add = async (noteId: string, extra: { quote?: string; suggestion?: string; idempotencyKey?: string } = {}) => {
    const result = await annotations.create(
      noteId,
      { quote: "target", body: "Check this passage", idempotencyKey: crypto.randomUUID(), ...extra },
      writer,
    );
    if (!result.ok) throw new Error(result.error.message);
    await sql`UPDATE notebooks.annotations SET created_at = ${new Date(Date.now())} WHERE id = ${result.data.id}::uuid`;
    return result.data;
  };
  const text = async (id: string) => (await notes.noteDocuments.read(id))?.text;
  const request = (noteId: string, suffix = "", method = "GET", body?: unknown, token = "writer") =>
    api.request(`/notes/${noteId}/annotations${suffix}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cld = async (args: string[], token = "writer") => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        new URL("../../../cloud-cli/src/index.ts", import.meta.url).pathname,
        "--server",
        `http://127.0.0.1:${http!.port}`,
        "--token",
        token,
        "--json",
        "notebooks",
        ...args,
      ],
      {
        env: { ...process.env, XDG_CONFIG_HOME: cliHome, CLD_LOCALE: "en" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  test("creation seeds stable Yjs items, records one activity and binds retry keys to the payload", async () => {
    const note = await noteFixture();
    const input = { quote: "target", body: "Review", suggestion: "replacement", idempotencyKey: "stable-comment" };
    const first = await annotations.create(note.shortId, input, writer);
    const retry = await annotations.create(note.shortId, input, writer);
    expect(first.ok && retry.ok && first.data.id === retry.data.id).toBeTrue();
    expect(first).toMatchObject({ ok: true, data: { via: "assistant", orphan: false, headingPath: ["Handbook"] } });
    expect(await annotations.create(note.shortId, { ...input, body: "Different" }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    const [stored] = await sql<
      { yjs_snapshot: Uint8Array; count: number }[]
    >`SELECT yjs_snapshot, (SELECT count(*)::int FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'annotation.create') AS count FROM notebooks.notes WHERE id = ${note.id}::uuid`;
    expect(stored?.yjs_snapshot.length).toBeGreaterThan(0);
    expect(stored?.count).toBe(1);
    expect(await annotations.list(note.shortId, {}, reader)).toMatchObject({
      ok: true,
      data: { text: "# Handbook\n\nBefore target after\n", items: [{ canEdit: false, canDelete: false }] },
    });
  });
  test("new passage comments project one quiet linked row, with no rows for replies or later changes", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    const read = async (context = reader, limit = 100) => {
      const result = await runNotebookActivity(
        ActivityInputSchema.parse({ notebook: notebookShortId, item: note.shortId, limit }),
        context,
      );
      if (!result.ok) throw new Error(result.error.message);
      return ActivityDataSchema.parse(result.data.data);
    };
    const href = `/open/notebooks.annotation/~${root.id}`;
    const rows = () => read().then((items) => items.filter((item) => item.href !== undefined));
    expect(await rows()).toEqual([
      expect.objectContaining({ href, sentence: "Review agent left a comment", icon: "ti ti-message-plus", count: 1 }),
    ]);
    expect((await read({ ...reader, locale: "de" })).find((item) => item.href === href)?.sentence).toBe(
      "Review agent hat einen Kommentar hinterlassen",
    );
    expect((await annotations.reply(note.shortId, root.id, { body: "A reply", idempotencyKey: "activity-reply" }, other)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, root.id, { kind: "edit", body: "Revised comment" }, writer)).ok).toBeTrue();
    for (const kind of ["resolve", "reopen"] as const)
      expect((await annotations.mutate(note.shortId, root.id, { kind }, writer)).ok).toBeTrue();
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect(await rows()).toHaveLength(1);
    // New roots stay separate even when they share an actor, note and edit bucket.
    const beforeDeleted = await read();
    const deleted = await add(note.shortId, { quote: "replacement" });
    expect(await rows()).toHaveLength(2);
    expect((await annotations.mutate(note.shortId, deleted.id, { kind: "delete" }, writer)).ok).toBeTrue();
    expect(await rows()).toHaveLength(1);
    // Deleted annotations are filtered before LIMIT in both timeline and ordinary activity consumers.
    expect(await read(reader, 1)).toEqual(beforeDeleted.slice(0, 1));
    expect(
      (
        await activity.list({
          notebookId,
          noteId: note.id,
          serviceAccountId: reader.actor.kind === "service_account" ? reader.actor.serviceAccount.id : null,
          actions: ["annotation.create"],
          limit: 1,
        })
      ).items,
    ).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ annotationId: root.id }) })]);
    if (reader.actor.kind !== "service_account") throw new Error("Expected service account");
    await sql`UPDATE auth.access SET permission = 'none' WHERE service_account_id = ${reader.actor.serviceAccount.id}::uuid`;
    try {
      expect(await runNotebookActivity(ActivityInputSchema.parse({ notebook: notebookShortId }), reader)).toMatchObject({
        ok: false,
        error: { status: 404 },
      });
      expect((await activity.list({ notebookId, serviceAccountId: reader.actor.serviceAccount.id, timeline: true })).items).toEqual([]);
    } finally {
      await sql`UPDATE auth.access SET permission = 'read' WHERE service_account_id = ${reader.actor.serviceAccount.id}::uuid`;
    }
  });
  // A held replay must be released in finally, even when a regression blocks
  // the competing request. Bound the assertion by the platform request budget.
  const withinRequestBudget = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Request blocked behind another note operation")),
            server.REQUEST_IDLE_TIMEOUT_SECONDS * 1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  test("parallel reads succeed while a create on the same note is replaying", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = notes.noteDocuments.read;
    const slow = spyOn(notes.noteDocuments, "read").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const creating = add(note.shortId);
    try {
      await withinRequestBudget(entered.promise);
      const results = await withinRequestBudget(Promise.all(Array.from({ length: 32 }, () => annotations.list(note.shortId, {}, reader))));
      expect(results.every((result) => result.ok)).toBeTrue();
      expect(results.map((result) => (result.ok ? result.data.text : null))).toEqual(Array(32).fill("# Handbook\n\nBefore target after\n"));
      const reads = await withinRequestBudget(
        Promise.all([
          annotations.read(note.shortId, root.id, reader),
          annotations.readResource(root.id, reader),
          annotations.replies(note.shortId, root.id, {}, reader),
        ]),
      );
      expect(reads).toMatchObject([
        { ok: true, data: { id: root.id } },
        { ok: true, data: { id: root.id } },
        { ok: true, data: { items: [] } },
      ]);
    } finally {
      release.resolve();
      try {
        await creating;
      } finally {
        slow.mockRestore();
      }
    }
  }, 20_000);
  test("a slow replay on note A does not block a create on note B", async () => {
    const noteA = await noteFixture();
    const noteB = await noteFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = notes.noteDocuments.read;
    const slow = spyOn(notes.noteDocuments, "read").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const creatingA = add(noteA.shortId);
    try {
      await withinRequestBudget(entered.promise);
      const createdB = await withinRequestBudget(add(noteB.shortId));
      expect(createdB).toMatchObject({ orphan: false, quote: "target" });
    } finally {
      release.resolve();
      try {
        await creatingA;
      } finally {
        slow.mockRestore();
      }
    }
  }, 20_000);
  test("concurrent creates on one note wait and reuse the same idempotent result", async () => {
    const note = await noteFixture();
    const input = { quote: "target", body: "Concurrent review", idempotencyKey: "concurrent-create" };
    const results = await Promise.all(Array.from({ length: 8 }, () => annotations.create(note.shortId, input, writer)));
    expect(results.every((result) => result.ok)).toBeTrue();
    expect(new Set(results.map((result) => (result.ok ? result.data.id : null))).size).toBe(1);
  }, 20_000);
  test("a write lock timeout returns a retryable conflict without inserting a comment", async () => {
    const note = await noteFixture();
    const pool = new SQL(requireDatabaseUrl());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = pool.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notebooks.annotations:${note.id}`}, 0))`;
      entered.resolve();
      await release.promise;
    });
    try {
      await withinRequestBudget(entered.promise);
      const startedAt = performance.now();
      expect(
        await withinRequestBudget(annotations.create(note.shortId, { quote: "target", body: "Review", idempotencyKey: "locked" }, writer)),
      ).toMatchObject({ ok: false, error: { status: 409, details: { retryable: true } } });
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual((server.REQUEST_IDLE_TIMEOUT_SECONDS * 1000) / 2);
      const [row] = await sql<{ count: number }[]>`SELECT count(*)::int FROM notebooks.annotations WHERE note_id = ${note.id}::uuid`;
      expect(row?.count).toBe(0);
    } finally {
      release.resolve();
      await holding;
      await pool.close();
    }
    expect((await add(note.shortId)).orphan).toBeFalse();
  }, 20_000);
  test("root activity is atomic and an unchanged retry never duplicates it", async () => {
    const note = await noteFixture();
    const activity = await import("./activity");
    const failure = spyOn(activity, "record").mockRejectedValueOnce(new Error("simulated activity failure"));
    const input = { quote: "target", body: "Review", idempotencyKey: "atomic-activity" };
    try {
      await expect(annotations.create(note.shortId, input, writer)).rejects.toThrow("simulated activity failure");
    } finally {
      failure.mockRestore();
    }
    const [before] = await sql<{ count: number }[]>`SELECT count(*)::int FROM notebooks.annotations WHERE note_id = ${note.id}::uuid`;
    expect(before?.count).toBe(0);
    expect((await annotations.create(note.shortId, input, writer)).ok).toBeTrue();
    expect((await annotations.create(note.shortId, input, writer)).ok).toBeTrue();
    const events = await sql<
      { occurrence_count: number }[]
    >`SELECT occurrence_count FROM notebooks.activity_events WHERE note_id = ${note.id}::uuid AND action = 'annotation.create'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.occurrence_count).toBe(1);
  });
  test("write grants apply equally to agents; authorship, expiry, replies and soft-delete undo are enforced", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    expect(await annotations.create(note.shortId, { quote: "target", body: "Denied", idempotencyKey: "no" }, reader)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await annotations.reply(note.shortId, root.id, { body: "Denied", idempotencyKey: "no" }, reader)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    for (const kind of ["edit", "delete"] as const)
      expect(await annotations.mutate(note.shortId, root.id, { kind, body: "Changed" }, other)).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
    const reply = await annotations.reply(note.shortId, root.id, { body: "A reply", idempotencyKey: "reply-key" }, other);
    if (!reply.ok) throw new Error(reply.error.message);
    await sql`UPDATE notebooks.annotation_replies SET created_at = ${new Date(Date.now())} WHERE id = ${reply.data.id}::uuid`;
    expect(await annotations.reply(note.shortId, root.id, { body: "A reply", idempotencyKey: "reply-key" }, other)).toMatchObject({
      ok: true,
      data: { id: reply.data.id },
    });
    expect(await annotations.reply(note.shortId, root.id, { body: "Different", idempotencyKey: "reply-key" }, other)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(await annotations.mutate(note.shortId, root.id, { kind: "delete" }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(
      (await annotations.mutate(note.shortId, root.id, { kind: "edit", replyId: reply.data.id, body: "Edited reply" }, other)).ok,
    ).toBeTrue();
    expect((await annotations.mutate(note.shortId, root.id, { kind: "delete", replyId: reply.data.id }, other)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, root.id, { kind: "restore", replyId: reply.data.id }, other)).ok).toBeTrue();
    await annotations.mutate(note.shortId, root.id, { kind: "delete", replyId: reply.data.id }, other);
    expect((await annotations.mutate(note.shortId, root.id, { kind: "delete" }, writer)).ok).toBeTrue();
    expect(await annotations.list(note.shortId, {}, writer)).toMatchObject({ ok: true, data: { items: [] } });
    expect((await annotations.mutate(note.shortId, root.id, { kind: "restore" }, writer)).ok).toBeTrue();
    await sql`UPDATE notebooks.annotations SET created_at = ${new Date(Date.now() - 601_000)} WHERE id = ${root.id}::uuid`;
    expect(await annotations.mutate(note.shortId, root.id, { kind: "edit", body: "Too late" }, writer)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
  });
  test("concurrent accepts apply once; retries and exact-range undo preserve unrelated text", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    const attempts = [
      { operationId: crypto.randomUUID(), context: writer },
      { operationId: crypto.randomUUID(), context: other },
    ];
    const outcomes = await Promise.all(
      attempts.map(({ operationId, context }) => annotations.operate(note.shortId, root.id, "accept", { operationId }, context)),
    );
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const winner = attempts[outcomes.findIndex((result) => result.ok)]!;
    expect(await text(note.id)).toBe("# Handbook\n\nBefore replacement after\n");
    const from = "# Handbook\n\nBefore ".length;
    expect(await annotations.list(note.shortId, {}, writer)).toMatchObject({
      ok: true,
      data: { items: [{ state: "accepted", orphan: false, from, to: from + "replacement".length }] },
    });
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId: winner.operationId }, winner.context)).ok).toBeTrue();
    expect((await annotations.operate(note.shortId, root.id, "undo", { operationId: crypto.randomUUID() }, other)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore target after\n");
    expect(await annotations.list(note.shortId, {}, writer)).toMatchObject({
      ok: true,
      data: { items: [{ state: "open", orphan: false, from, to: from + "target".length }] },
    });
  });
  test("changed passages and changed accepted text create durable conflicts with current text", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    await notes.editContent({
      noteId: note.id,
      createdBy: null,
      data: { operations: [{ kind: "set-content", content: "# Handbook\n\nBefore changed after\n" }] },
    });
    const result = await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID() }, writer);
    expect(result).toMatchObject({ ok: false, error: { status: 409 } });
    const second = await noteFixture();
    const comment = await add(second.shortId, { suggestion: "replacement" });
    await annotations.operate(second.shortId, comment.id, "accept", { operationId: crypto.randomUUID() }, writer);
    await notes.editContent({
      noteId: second.id,
      createdBy: null,
      data: { operations: [{ kind: "set-content", content: "# Handbook\n\nBefore changed after\n" }] },
    });
    expect(await annotations.operate(second.shortId, comment.id, "undo", { operationId: crypto.randomUUID() }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
  });
  test("suggestion approval snapshots follow the replacement and the actual accepted source", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    const accept = notebooksCapabilities.actions["annotation.accept"];
    const input = { noteId: note.shortId, annotationId: root.id, operationId: crypto.randomUUID() };
    const first = await accept.review!(input, writer);
    expect(first).toMatchObject({
      ok: true,
      data: { details: expect.arrayContaining([{ label: "Replace with", value: "replacement", display: "block" }]) },
    });
    await annotations.mutate(note.shortId, root.id, { kind: "edit", body: "Check", suggestion: "revised" }, writer);
    const second = await accept.review!(input, writer);
    expect(second).toMatchObject({
      ok: true,
      data: { details: expect.arrayContaining([{ label: "Replace with", value: "revised", display: "block" }]) },
    });
    expect(second).not.toEqual(first);
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId: input.operationId }, writer)).ok).toBeTrue();
    expect(await annotations.readResource(root.id, writer)).toMatchObject({ ok: true, data: { canDelete: false } });
    expect(await annotations.mutate(note.shortId, root.id, { kind: "delete" }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(await annotations.previewOperation(note.shortId, root.id, "undo", undefined, writer)).toMatchObject({
      ok: true,
      data: { before: "revised", after: "target" },
    });
  });
  test("publish-success/persist-failure retries complete the stored transaction exactly once", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    const operationId = crypto.randomUUID();
    const originalSave = notes.save;
    const failure = spyOn(notes, "save").mockRejectedValueOnce(new Error("simulated store failure"));
    try {
      const failed = await annotations.operate(note.shortId, root.id, "accept", { operationId }, writer);
      expect(failed).toMatchObject({ ok: false, error: { code: "ANNOTATION_OPERATION_PENDING", details: { operationId } } });
    } finally {
      failure.mockRestore();
    }
    expect(notes.save).toBe(originalSave);
    expect(await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID() }, other)).toMatchObject({
      ok: false,
      error: { status: 409, details: { operationId, status: "pending" } },
    });
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId }, writer)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore replacement after\n");
    expect((await notes.getWithContent({ id: note.id }))?.contentMd).toBe("# Handbook\n\nBefore replacement after\n");
    const [row] = await sql<{ status: string }[]>`SELECT status FROM notebooks.annotation_operations WHERE id = ${operationId}::uuid`;
    expect(row?.status).toBe("applied");
  });
  test("deletion suggestions undo at one point and locked notes still allow comments and resolution", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "" });
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore  after\n");
    expect((await annotations.operate(note.shortId, root.id, "undo", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore target after\n");
    await sql`UPDATE notebooks.notes SET locked_at = now() WHERE id = ${note.id}::uuid`;
    const locked = await add(note.shortId, { suggestion: "new" });
    expect((await annotations.reply(note.shortId, locked.id, { body: "Still possible", idempotencyKey: "locked" }, writer)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, locked.id, { kind: "resolve" }, other)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, locked.id, { kind: "reopen" }, other)).ok).toBeTrue();
    expect(await annotations.operate(note.shortId, locked.id, "accept", { operationId: crypto.randomUUID() }, writer)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
  });
  test("root and reply pages progress through exact Postgres timestamps without skipping threads", async () => {
    const note = await noteFixture();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await annotations.create(
        note.shortId,
        { quote: "target", body: `Comment ${index}`, idempotencyKey: `page-${index}` },
        writer,
      );
      if (!result.ok) throw new Error(result.error.message);
      ids.push(result.data.id);
    }
    const invalidCursor = Buffer.from(JSON.stringify({ at: "0", id: ids[0] })).toString("base64url");
    expect(await annotations.list(note.shortId, { cursor: invalidCursor }, writer)).toMatchObject({ ok: false, error: { status: 400 } });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await annotations.list(note.shortId, { limit: 1, cursor }, writer);
      if (!result.ok) throw new Error(result.error.message);
      seen.push(...result.data.items.map((item) => item.id));
      cursor = result.data.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    for (let index = 0; index < 4; index++)
      expect(
        (await annotations.reply(note.shortId, ids[0]!, { body: `Reply ${index}`, idempotencyKey: `reply-page-${index}` }, writer)).ok,
      ).toBeTrue();
    const first = await annotations.replies(note.shortId, ids[0]!, { limit: 2 }, writer);
    if (!first.ok) throw new Error(first.error.message);
    const second = await annotations.replies(note.shortId, ids[0]!, { limit: 2, cursor: first.data.nextCursor! }, writer);
    if (!second.ok) throw new Error(second.error.message);
    expect([...first.data.items, ...second.data.items].map((item) => item.body)).toEqual(["Reply 0", "Reply 1", "Reply 2", "Reply 3"]);
    expect(second.data.nextCursor).toBeNull();
  });
  test("snapshot restore reanchors only with strong context and updates the stored revision", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    expect(
      (await notes.editContent({ noteId: note.id, createdBy: null, data: { operations: [{ kind: "set-content", content: "" }] } })).ok,
    ).toBeTrue();
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.clientID = 300;
    try {
      doc.getText("codemirror").insert(0, "# Handbook\n\nBefore target after\n");
      expect(
        (
          await notes.restoreFromSnapshot({
            noteId: note.id,
            yjsSnapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
            createdBy: null,
          })
        ).ok,
      ).toBeTrue();
      expect(await annotations.read(note.shortId, root.id, writer)).toMatchObject({
        ok: true,
        data: { orphan: false, restoreRevision: "1" },
      });
    } finally {
      doc.destroy();
    }
  });
  test("REST preserves conflict recovery details and rejects caller-supplied provenance", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    const operationId = crypto.randomUUID();
    const response = await request(note.shortId, `/${root.id}/accept`, "POST", { operationId, expectedText: "another passage" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONFLICT", details: { operationId, currentText: "target" } });
    const [stored] = await sql<{ status: string }[]>`SELECT status FROM notebooks.annotation_operations WHERE id = ${operationId}::uuid`;
    expect(stored?.status).toBe("conflict");
    expect(
      (await request(note.shortId, "", "POST", { quote: "target", body: "No spoofing", idempotencyKey: "spoof", via: "assistant" })).status,
    ).toBe(400);
  });
  test("REST, capability and CLI author checks also enforce expiry and live replies", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    const cap = notebooksCapabilities.actions;
    const denied = async (context: CapabilityExecutionContext, token: string) => {
      expect((await request(note.shortId, `/${root.id}`, "PATCH", { body: "Denied" }, token)).status).toBe(403);
      expect((await request(note.shortId, `/${root.id}`, "DELETE", undefined, token)).status).toBe(403);
      expect(await cap["annotation.edit"].run({ noteId: note.shortId, annotationId: root.id, body: "Denied" }, context)).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      expect(await cap["annotation.delete"].run({ noteId: note.shortId, annotationId: root.id }, context)).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      expect((await cld(["annotations", "edit", note.shortId, root.id, "--content", "Denied"], token)).code).not.toBe(0);
      expect((await cld(["annotations", "delete", note.shortId, root.id, "--yes"], token)).code).not.toBe(0);
    };
    await denied(other, "other");
    expect((await annotations.reply(note.shortId, root.id, { body: "Keep the thread", idempotencyKey: "keep" }, other)).ok).toBeTrue();
    expect((await request(note.shortId, `/${root.id}`, "DELETE")).status).toBe(409);
    expect(await cap["annotation.delete"].run({ noteId: note.shortId, annotationId: root.id }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect((await cld(["annotations", "delete", note.shortId, root.id, "--yes"])).code).not.toBe(0);
    await sql`UPDATE notebooks.annotations SET created_at = ${new Date(Date.now() - 601_000)} WHERE id = ${root.id}::uuid`;
    await denied(writer, "writer");
  }, 60_000);
  test("conflict text stays bounded after typing expands the selected passage", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "replacement" });
    expect(
      (
        await notes.editContent({
          noteId: note.id,
          createdBy: null,
          data: { operations: [{ kind: "set-content", content: "# Handbook\n\nBefore ta" + "x".repeat(2100) + "rget after\n" }] },
        })
      ).ok,
    ).toBeTrue();
    const operationId = crypto.randomUUID();
    const response = await request(note.shortId, `/${root.id}/accept`, "POST", { operationId });
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toMatchObject({ details: { operationId, currentTextTruncated: true, currentTextLength: 2106 } });
    expect(result.details.currentText.length).toBe(2000);
  });
  test("a person comments, an Assistant replies with suggestions, and REST accept/undo preserve history and other anchors", async () => {
    const content = "# Membership\n\nBefore target after. Another passage stays.\n";
    const note = await noteFixture(content);
    const response = await request(
      note.shortId,
      "",
      "POST",
      { quote: "target", body: "Should we change this?", idempotencyKey: "person-comment" },
      "person",
    );
    expect(response.status).toBe(200);
    const root = await response.json();
    expect(root).toMatchObject({ author: { kind: "user", id: user.id }, suggestion: null, suggestionState: null, stateVia: null });
    const preserved = await add(note.shortId, { quote: "Another passage" });
    const cap = notebooksCapabilities;
    const listed = await cap.queries["annotation.list"].run({ noteId: note.shortId, author: user.id, state: "open", limit: 1 }, writer);
    expect(listed).toMatchObject({ ok: true, data: { data: { items: [{ id: root.id }] } } });
    const cliList = await cld(["annotations", "list", note.shortId, "--state", "open", "--author", user.id]);
    expect(cliList.code).toBe(0);
    expect(JSON.parse(cliList.stdout).items.map((item: { id: string }) => item.id)).toEqual([root.id]);
    const proposed = await cap.actions["annotation.reply"].run(
      { noteId: note.shortId, annotationId: root.id, body: "Here is clearer wording.", suggestion: "replacement" },
      { ...writer, idempotencyKey: "agent-suggestion" },
    );
    if (!proposed.ok) throw new Error(proposed.error.message);
    const replyId = proposed.data.data.id;
    expect(proposed.data.data).toMatchObject({
      via: "assistant",
      suggestion: "replacement",
      suggestionState: "open",
      author: { kind: "service_account" },
    });
    const alternative = await annotations.reply(
      note.shortId,
      root.id,
      { suggestion: "another replacement", idempotencyKey: "alternative" },
      other,
    );
    expect(alternative.ok).toBeTrue();
    const preview = await cap.actions["annotation.accept"].review!({ noteId: note.shortId, annotationId: root.id, replyId }, personContext);
    expect(preview).toMatchObject({
      ok: true,
      data: { details: expect.arrayContaining([{ label: "Replace with", value: "replacement", display: "block" }]) },
    });
    const operationId = crypto.randomUUID();
    expect((await request(note.shortId, `/${root.id}/accept`, "POST", { operationId, replyId }, "person")).status).toBe(200);
    expect(await text(note.id)).toBe(content.replace("target", "replacement"));
    const [version] = await sql<
      { content_md: string; actor_id: string; actor_kind: string }[]
    >`SELECT version.content_md, contributor.actor_id, contributor.actor_kind
      FROM notebooks.note_versions version JOIN notebooks.note_version_contributors contributor ON contributor.version_id = version.id
      WHERE version.note_id = ${note.id}::uuid ORDER BY version.created_at DESC, version.id DESC LIMIT 1`;
    expect(version).toMatchObject({ content_md: content.replace("target", "replacement"), actor_id: user.id, actor_kind: "user" });
    expect(await annotations.list(note.shortId, { state: "accepted", author: user.id }, reader)).toMatchObject({
      ok: true,
      data: { items: [{ id: root.id }], nextCursor: null },
    });
    const state = await annotations.readResource(root.id, reader);
    expect(state).toMatchObject({
      ok: true,
      data: {
        state: "accepted",
        stateBy: { id: user.id },
        stateVia: null,
        suggestionState: null,
        replies: [
          {
            id: replyId,
            suggestionState: "accepted",
            suggestionStateBy: { id: user.id },
            suggestionStateAt: expect.any(String),
            suggestionStateVia: null,
          },
          { suggestionState: "open" },
        ],
      },
    });
    const range = await annotations.read(note.shortId, preserved.id, reader);
    if (!range.ok) throw new Error(range.error.message);
    expect(range.data.orphan).toBeFalse();
    expect((await text(note.id))!.slice(range.data.from, range.data.to)).toBe("Another passage");
    expect((await request(note.shortId, `/${root.id}/accept`, "POST", { operationId, replyId }, "person")).status).toBe(200);
    expect((await request(note.shortId, `/${root.id}/accept`, "POST", { operationId }, "person")).status).toBe(409);
    expect((await request(note.shortId, `/${root.id}/undo-accept`, "POST", { operationId: crypto.randomUUID() }, "person")).status).toBe(
      200,
    );
    expect(await text(note.id)).toBe(content);
    expect(await annotations.readResource(root.id, reader)).toMatchObject({
      ok: true,
      data: { state: "open", replies: [{ id: replyId, suggestionState: "open" }, { suggestionState: "open" }] },
    });
    const shown = await cld(["annotations", "show", root.id], "reader");
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: root.id, quote: "target", replies: [{ id: replyId }, {}] });
  }, 60_000);
  test("rejection is idempotent, targets one suggestion and prevents accept without changing text", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "root replacement" });
    const proposed = await annotations.reply(
      note.shortId,
      root.id,
      { suggestion: "reply replacement", idempotencyKey: "reject-reply" },
      writer,
    );
    if (!proposed.ok) throw new Error(proposed.error.message);
    const replyId = proposed.data.id;
    expect((await request(note.shortId, `/${root.id}/reject`, "POST", { replyId }, "person")).status).toBe(200);
    const rejected = await annotations.readResource(root.id, reader);
    expect(rejected).toMatchObject({
      ok: true,
      data: { state: "open", suggestionState: "open", replies: [{ suggestionState: "rejected", suggestionStateBy: { id: user.id } }] },
    });
    expect((await request(note.shortId, `/${root.id}/reject`, "POST", { replyId }, "person")).status).toBe(200);
    expect(await annotations.readResource(root.id, reader)).toEqual(rejected);
    expect(
      (await request(note.shortId, `/${root.id}/accept`, "POST", { operationId: crypto.randomUUID(), replyId }, "person")).status,
    ).toBe(409);
    expect(await text(note.id)).toBe("# Handbook\n\nBefore target after\n");
    expect((await cld(["annotations", "reject", note.shortId, root.id, "--reply", replyId, "--undo"], "person")).code).toBe(0);
    expect(await annotations.readResource(root.id, reader)).toMatchObject({ ok: true, data: { replies: [{ suggestionState: "open" }] } });
    expect(
      await notebooksCapabilities.actions["annotation.reject"].run({ noteId: note.shortId, annotationId: root.id, rejected: true }, writer),
    ).toMatchObject({ ok: true });
    expect(await annotations.readResource(root.id, reader)).toMatchObject({
      ok: true,
      data: { suggestionState: "rejected", suggestionStateVia: "assistant" },
    });
    expect((await annotations.reject(note.shortId, root.id, { rejected: false }, writer)).ok).toBeTrue();
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect(await annotations.readResource(root.id, reader)).toMatchObject({
      ok: true,
      data: { stateVia: "assistant", suggestionStateVia: "assistant", suggestionState: "accepted", replies: [{ suggestionState: "open" }] },
    });
    expect(await annotations.mutate(note.shortId, root.id, { kind: "delete" }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect((await annotations.reject(note.shortId, root.id, {}, writer)).ok).toBeFalse();
    expect((await annotations.operate(note.shortId, root.id, "undo", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, root.id, { kind: "resolve" }, writer)).ok).toBeTrue();
    expect(await annotations.readResource(root.id, reader)).toMatchObject({ ok: true, data: { state: "resolved", stateVia: "assistant" } });
  });
  test("quote occurrence errors are distinct on service, REST, capabilities and CLI", async () => {
    const note = await noteFixture("# Repeated\n\ntarget, then target\n");
    const input = { quote: "target", body: "Check", idempotencyKey: "ambiguous" };
    expect(await annotations.create(note.shortId, input, writer)).toMatchObject({
      ok: false,
      error: { code: "ANNOTATION_PASSAGE_AMBIGUOUS", status: 409, details: { matches: 2 } },
    });
    const response = await request(note.shortId, "", "POST", input);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ANNOTATION_PASSAGE_AMBIGUOUS",
      details: { matches: 2 },
      message: "The quote occurs 2 times; pass --occurrence, --prefix/--suffix or --offset-hint",
    });
    expect(await annotations.create(note.shortId, { ...input, occurrence: 3 }, writer)).toMatchObject({
      ok: false,
      error: { code: "ANNOTATION_PASSAGE_NOT_FOUND", details: { matches: 2 } },
    });
    expect(await annotations.create(note.shortId, { ...input, quote: "absent" }, writer)).toMatchObject({
      ok: false,
      error: { code: "ANNOTATION_PASSAGE_NOT_FOUND", message: "The quote does not occur in the note", details: { matches: 0 } },
    });
    const created = await notebooksCapabilities.actions["annotation.create"].run(
      notebooksCapabilities.actions["annotation.create"].input.parse({
        noteId: note.shortId,
        quote: "target",
        occurrence: 2,
        body: "Second",
      }),
      { ...writer, idempotencyKey: "second" },
    );
    expect(created).toMatchObject({ ok: true, data: { data: { from: "# Repeated\n\ntarget, then ".length } } });
    const added = await cld([
      "annotations",
      "add",
      note.shortId,
      "--quote",
      "target",
      "--occurrence",
      "2",
      "--suggestion",
      "replacement",
      "--idempotency-key",
      "cli-second",
    ]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ from: "# Repeated\n\ntarget, then ".length, suggestionState: "open" });
    const ambiguous = await cld([
      "annotations",
      "add",
      note.shortId,
      "--quote",
      "target",
      "--content",
      "Check",
      "--idempotency-key",
      "cli-ambiguous",
    ]);
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain("--occurrence");
  }, 60_000);
  test("filters select thread state and root author before paging, including actor-relative me", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    const response = await request(note.shortId, "", "POST", { quote: "target", body: "Person comment", idempotencyKey: "mine" }, "person");
    const mine = await response.json();
    await annotations.reply(note.shortId, mine.id, { body: "Agent reply", idempotencyKey: "not-root-author" }, writer);
    await annotations.mutate(note.shortId, root.id, { kind: "resolve" }, writer);
    expect(await annotations.list(note.shortId, { author: "me", state: "open", limit: 1 }, personContext)).toMatchObject({
      ok: true,
      data: { items: [{ id: mine.id }], nextCursor: null },
    });
    expect(await annotations.list(note.shortId, { author: "me", state: "open" }, writer)).toMatchObject({ ok: true, data: { items: [] } });
    expect(await annotations.list(note.shortId, { state: "resolved" }, reader)).toMatchObject({
      ok: true,
      data: { items: [{ id: root.id }] },
    });
    expect(await annotations.list(note.shortId, { state: "accepted" }, reader)).toMatchObject({ ok: true, data: { items: [] } });
    expect(await annotations.list(note.shortId, { author: "invalid" }, reader)).toMatchObject({ ok: false, error: { status: 400 } });
    const listed = await request(note.shortId, "?state=open&author=me&limit=1", "GET", undefined, "person");
    expect(await listed.json()).toMatchObject({ items: [{ id: mine.id }], nextCursor: null });
    const show = await api.request(`/annotations/${mine.id}`, { headers: { authorization: "Bearer reader" } });
    expect(show.status).toBe(200);
  });
  test("reply suggestions validate content, bind retries and remain recoverable after partial publication", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    for (const suggestion of [null, "target"])
      expect(await annotations.reply(note.shortId, root.id, { suggestion, idempotencyKey: "empty" }, writer)).toMatchObject({
        ok: false,
        error: { status: 400 },
      });
    const plain = { body: JSON.stringify({ body: "Review", suggestion: "replacement" }), idempotencyKey: "plain-retry" };
    expect((await annotations.reply(note.shortId, root.id, plain, writer)).ok).toBeTrue();
    expect(
      await annotations.reply(
        note.shortId,
        root.id,
        { body: "Review", suggestion: "replacement", idempotencyKey: plain.idempotencyKey },
        writer,
      ),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const input = { suggestion: "", idempotencyKey: "deletion" };
    const reply = await annotations.reply(note.shortId, root.id, input, writer);
    if (!reply.ok) throw new Error(reply.error.message);
    expect(reply.data).toMatchObject({ suggestion: "", body: "", suggestionState: "open" });
    expect(await annotations.reply(note.shortId, root.id, input, writer)).toMatchObject({ ok: true, data: { id: reply.data.id } });
    expect(await annotations.reply(note.shortId, root.id, { ...input, suggestion: "different" }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    const operationId = crypto.randomUUID();
    const failure = spyOn(notes, "save").mockRejectedValueOnce(new Error("simulated reply store failure"));
    try {
      expect(await annotations.operate(note.shortId, root.id, "accept", { operationId, replyId: reply.data.id }, writer)).toMatchObject({
        ok: false,
        error: { code: "ANNOTATION_OPERATION_PENDING" },
      });
    } finally {
      failure.mockRestore();
    }
    expect((await annotations.reject(note.shortId, root.id, { replyId: reply.data.id }, other)).ok).toBeFalse();
    expect((await annotations.operate(note.shortId, root.id, "accept", { operationId, replyId: reply.data.id }, writer)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore  after\n");
    expect(await annotations.readResource(root.id, reader)).toMatchObject({
      ok: true,
      data: { replies: [{ suggestionState: null }, { suggestionState: "accepted", suggestionStateVia: "assistant" }] },
    });
    expect((await annotations.operate(note.shortId, root.id, "undo", { operationId: crypto.randomUUID() }, other)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore target after\n");
  });
  test("reply edits preserve or reset suggestion state and cannot alter an accepted replacement", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId);
    const proposed = await annotations.reply(
      note.shortId,
      root.id,
      { body: "Initial", suggestion: "replacement", idempotencyKey: "edit-suggestion" },
      writer,
    );
    if (!proposed.ok) throw new Error(proposed.error.message);
    const replyId = proposed.data.id;
    await sql`UPDATE notebooks.annotation_replies SET created_at = ${new Date(Date.now())} WHERE id = ${replyId}::uuid`;
    expect((await annotations.reject(note.shortId, root.id, { replyId }, other)).ok).toBeTrue();
    expect((await annotations.mutate(note.shortId, root.id, { kind: "edit", replyId, body: "Body only" }, writer)).ok).toBeTrue();
    expect(await annotations.readResource(root.id, writer)).toMatchObject({
      ok: true,
      data: { replies: [{ suggestion: "replacement", suggestionState: "rejected" }] },
    });
    expect((await request(note.shortId, `/${root.id}/replies/${replyId}`, "PATCH", { body: "", suggestion: "revised" })).status).toBe(200);
    expect(await annotations.readResource(root.id, writer)).toMatchObject({
      ok: true,
      data: { replies: [{ suggestion: "revised", suggestionState: "open", suggestionStateBy: { id: proposed.data.author.id } }] },
    });
    expect(
      (await annotations.operate(note.shortId, root.id, "accept", { operationId: crypto.randomUUID(), replyId }, writer)).ok,
    ).toBeTrue();
    expect(
      await annotations.mutate(
        note.shortId,
        root.id,
        { kind: "edit", replyId, body: "Try changing the accepted replacement", suggestion: "different" },
        writer,
      ),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await annotations.mutate(note.shortId, root.id, { kind: "delete", replyId }, writer)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(await annotations.readResource(root.id, writer)).toMatchObject({
      ok: true,
      data: { canDelete: false, replies: [{ id: replyId, canDelete: false }] },
    });
    expect((await annotations.operate(note.shortId, root.id, "undo", { operationId: crypto.randomUUID() }, writer)).ok).toBeTrue();
    expect(await text(note.id)).toBe("# Handbook\n\nBefore target after\n");
    expect(
      (await annotations.mutate(note.shortId, root.id, { kind: "edit", replyId, body: "Discussion only", suggestion: null }, writer)).ok,
    ).toBeTrue();
    expect(await annotations.readResource(root.id, writer)).toMatchObject({
      ok: true,
      data: {
        replies: [{ suggestion: null, suggestionState: null, suggestionStateBy: null, suggestionStateAt: null, suggestionStateVia: null }],
      },
    });
  });
  test("REST, capabilities and CLI all reject read-only mutations and respect revocation", async () => {
    const note = await noteFixture();
    const root = await add(note.shortId, { suggestion: "new" });
    expect((await request(note.shortId, "", "GET", undefined, "reader")).status).toBe(200);
    expect((await api.request(`/annotations/${root.id}`, { headers: { authorization: "Bearer reader" } })).status).toBe(200);
    expect((await notebooksCapabilities.queries["annotation.read"].run({ id: root.id }, reader)).ok).toBeTrue();
    expect((await cld(["annotations", "show", root.id], "reader")).code).toBe(0);
    expect(
      (await notebooksCapabilities.queries["annotation.list"].run({ noteId: note.shortId, state: "all", limit: 30 }, reader)).ok,
    ).toBeTrue();
    for (const [suffix, body] of [
      ["", { quote: "target", body: "Denied", idempotencyKey: "rest-denied" }],
      [`/${root.id}/replies`, { body: "Denied", idempotencyKey: "rest-reply-denied" }],
      [`/${root.id}/replies`, { suggestion: "replacement", idempotencyKey: "rest-suggestion-denied" }],
      [`/${root.id}/reject`, {}],
      [`/${root.id}/resolve`, { resolved: true }],
      [`/${root.id}/accept`, { operationId: crypto.randomUUID() }],
    ] as const)
      expect((await request(note.shortId, suffix, "POST", body, "reader")).status).toBe(403);
    const cap = notebooksCapabilities.actions;
    expect(
      await cap["annotation.create"].run(cap["annotation.create"].input.parse({ noteId: note.shortId, quote: "target", body: "Denied" }), {
        ...reader,
        idempotencyKey: "cap-denied",
      }),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    expect(
      await cap["annotation.reply"].run(
        { noteId: note.shortId, annotationId: root.id, body: "Denied" },
        { ...reader, idempotencyKey: "cap-reply-denied" },
      ),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    expect(
      await cap["annotation.reply"].run(
        { noteId: note.shortId, annotationId: root.id, body: "", suggestion: "replacement" },
        { ...reader, idempotencyKey: "cap-suggestion-no" },
      ),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await cap["annotation.reject"].run({ noteId: note.shortId, annotationId: root.id, rejected: true }, reader)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await cap["annotation.resolve"].run({ noteId: note.shortId, annotationId: root.id, resolved: true }, reader)).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(
      await cap["annotation.accept"].run({ noteId: note.shortId, annotationId: root.id, operationId: crypto.randomUUID() }, reader),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    const added = await cld([
      "annotations",
      "add",
      note.shortId,
      "--quote",
      "target",
      "--content",
      "CLI comment",
      "--idempotency-key",
      "cli-comment",
    ]);
    expect({ code: added.code, error: added.stderr }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(added.stdout)).toMatchObject({ body: "CLI comment", via: null });
    for (const args of [
      ["add", note.shortId, "--quote", "target", "--content", "Denied", "--idempotency-key", "cli-no"],
      ["reply", note.shortId, root.id, "--content", "Denied", "--idempotency-key", "cli-reply-no"],
      ["reply", note.shortId, root.id, "--suggestion", "replacement", "--idempotency-key", "cli-suggestion-no"],
      ["reject", note.shortId, root.id],
      ["resolve", note.shortId, root.id],
      ["accept", note.shortId, root.id, "--operation-id", crypto.randomUUID(), "--yes"],
    ])
      expect((await cld(["annotations", ...args], "reader")).code).not.toBe(0);
    const listed = await cld(["annotations", "list", note.shortId], "reader");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).items.length).toBe(2);
    if (reader.actor.kind !== "service_account") throw new Error("Expected service account");
    await sql`DELETE FROM auth.access WHERE service_account_id = ${reader.actor.serviceAccount.id}::uuid`;
    expect((await request(note.shortId, "", "GET", undefined, "reader")).status).toBe(404);
    expect((await annotations.list(note.shortId, {}, reader)).ok).toBeFalse();
    expect((await api.request(`/annotations/${root.id}`, { headers: { authorization: "Bearer reader" } })).status).toBe(404);
    expect((await notebooksCapabilities.queries["annotation.read"].run({ id: root.id }, reader)).ok).toBeFalse();
    expect((await cld(["annotations", "show", root.id], "reader")).code).not.toBe(0);
    expect((await cld(["annotations", "list", note.shortId], "reader")).code).not.toBe(0);
  }, 60_000);
}
