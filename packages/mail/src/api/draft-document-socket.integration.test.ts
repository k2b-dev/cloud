import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { getProcessSync, sql } from "@k2b/cloud";
import { defineLive, subscribeIdentityAccessChanged } from "@k2b/cloud/events";
import { startLiveOutbox } from "@k2b/cloud/events/testing";
import { auth } from "@k2b/cloud/server";
import { fromBase64, MalformedSharedTextEventError, toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { StoreFullError, type TopicConfig } from "@k2b/sync";
import type { Server } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { useRegisteredTestApp } from "../../../cloud/src/services/identity/application.test-fixture";
import { prepareDraftSendBinding } from "../../test/fixtures/draft-send";
import { draftEditableContentInputSchema } from "../contracts";
import { createDraftRevisionUpdate, readDraftDocument as readModel } from "../lib/draft-document";
import { type MailDraftDocumentMessage, mailDraftDocumentMessageSchema } from "../lib/draft-document-protocol";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { mailDraftRoom } from "../service/draft-document-room";
import {
  draftDocumentSnapshotStore,
  draftDocumentSnapshots,
  flushDraftDocumentSnapshot,
  stopDraftDocumentSnapshots,
} from "../service/draft-document-snapshots";
import * as draftDocumentService from "../service/draft-documents";
import { acceptDraftDocumentUpdate, mailDraftDocumentLog, readDraftDocument } from "../service/draft-documents";
import { mailLive } from "../service/live";
import { createMailbox } from "../service/mailboxes";
import { stopMailDraftConnections, upgradeMailDraftDocumentSocket } from "./draft-document-socket";
import type { MailApiContext } from "./public-resource-boundary";

// Bun accepts headers; lib.dom's global constructor omits Bun's options overload.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

useRegisteredTestApp("mail");
const suite = suiteFor("database", "nats");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const decode = (bytes: Uint8Array) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return readModel(doc);
  } finally {
    doc.destroy();
  }
};

suite("Mail document socket with real SQL, retained topic and WebSockets", () => {
  let server: Server<unknown>;
  let app: Hono<MailApiContext>;
  const startServer = () => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, runtime) => app.fetch(request, runtime), websocket });
  };
  let context: MailRequestContext;
  let otherContext: MailRequestContext;
  let requestContext: MailRequestContext;
  let mailboxId: string;
  let identity: { id: string; short_id: string };
  let currentDraft: { id: string; short_id: string };
  let stopLive: (() => Promise<void>) | null = null;
  let authentication: { mockRestore(): void };
  let authenticationReads = 0;
  let activeSession: Awaited<ReturnType<typeof auth.session.authenticate>>;
  const sockets = new Set<WebSocket>();
  const token = "socket-fixture-browser-session";

  beforeAll(async () => {
    const uid = `mail-socket-${newShortId()}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${uid}, 'local', 'user', 'Socket Person', ${`${uid}@example.test`}) RETURNING id
    `;
    if (!user) throw new Error("Missing socket user");
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          roles: ["user"],
          displayName: "Socket Person",
          givenname: "Socket",
          sn: "Person",
          mail: `${uid}@example.test`,
          avatarHash: null,
          accountExpires: null,
          lastLoginLocal: null,
          ipa: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId: user.id },
    };
    if (context.actor.kind !== "user") throw new Error("User fixture required");
    activeSession = {
      data: { userId: user.id, sid: "fixture", authEpoch: 0, expiresAt: "2100-01-01T00:00:00.000Z", kind: "web" },
      user: context.actor.user,
    };
    // Identity middleware is tested by Cloud. This fixture replaces ONLY credential verification;
    // cookie selection, socket transport, room admission, SQL snapshots and NATS remain real.
    authentication = spyOn(auth.session, "authenticate").mockImplementation(async (credential) => {
      authenticationReads++;
      return credential === token ? activeSession : null;
    });
    mailboxId = value(await createMailbox(context, { name: `Socket ${newShortId()}`, description: "Transport fixture" })).id;
    const otherUid = `mail-socket-${newShortId()}`;
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${otherUid}, 'local', 'user', 'Other Socket Person', ${`${otherUid}@example.test`}) RETURNING id
    `;
    if (!other) throw new Error("Missing second socket user");
    otherContext = {
      actor: { kind: "user", user: { ...context.actor.user, id: other.id, uid: otherUid, displayName: "Other Socket Person" } },
      accessSubject: { type: "user", userId: other.id },
    };
    requestContext = context;
    value(await grantMailboxAccess({ context, mailboxId, principal: otherContext.accessSubject, permission: "write" }));
    const [sender] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Sender', 'Sender', 'sender@example.test', 'disabled', 'verified') RETURNING id, short_id
    `;
    if (!sender) throw new Error("Missing socket sender");
    identity = sender;
    await prepareDraftSendBinding(mailboxId, identity.id);
    app = new Hono<MailApiContext>()
      .use("*", async (c, next) => {
        c.set("actor", requestContext.actor);
        c.set("accessSubject", requestContext.accessSubject);
        c.set("credentialKind", "session");
        c.set("internalMailboxId", mailboxId);
        c.set("internalDraftId", currentDraft.id);
        await next();
      })
      .get("/mailboxes/:mailboxId/drafts/:draftId/document/socket", upgradeMailDraftDocumentSocket);
    startServer();
    await draftDocumentSnapshots.start();
    stopLive = await startLiveOutbox("mail");
  });
  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.clear();
    await stopMailDraftConnections();
  });
  afterAll(async () => {
    await stopMailDraftConnections();
    await stopDraftDocumentSnapshots();
    await stopLive?.();
    await server?.stop(true);
    authentication?.mockRestore();
    // A cancelled join must finish rollback before fixture deletion/pool close.
    // Report a leaked transaction here, instead of timing out in a later hook.
    expect(
      await sql`SELECT pid, state, left(query, 160) AS query FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
    ).toHaveLength(0);
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
    }
    if (context?.actor.kind === "user") await sql`DELETE FROM auth.users WHERE id = ${context.actor.user.id}::uuid`;
    if (otherContext?.actor.kind === "user") await sql`DELETE FROM auth.users WHERE id = ${otherContext.actor.user.id}::uuid`;
  });

  const draft = async () => {
    const content = draftEditableContentInputSchema.parse({
      quoteSource: null,
      senderIdentityId: identity.short_id,
      signatureTemplateId: null,
      to: [{ address: "recipient@example.test", name: null }],
      cc: [],
      bcc: [],
      subject: "Subject",
      body: "Original",
      format: "plain",
      priority: "normal",
      requestDeliveryReceipt: false,
      requestReadReceipt: false,
    });
    if (context.actor.kind !== "user") throw new Error("User fixture required");
    const [row] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id,
        to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format, priority, request_delivery_receipt, request_read_receipt, edit_mode)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${identity.id}::uuid, 'user', ${context.actor.user.id}::uuid,
        'user', ${context.actor.user.id}::uuid, ${content.to}::jsonb, '[]'::jsonb, '[]'::jsonb, ${content.subject}, ${content.body},
        'plain', 'normal', false, false, 'shared') RETURNING id, short_id
    `;
    if (!row) throw new Error("Missing socket draft");
    currentDraft = row;
    return { ...row, content };
  };
  const read = () => readDraftDocument({ context, mailboxId, draftId: currentDraft.id }).then(value);
  const connect = async (
    cookie = `session_token=${token}`,
    expectedUserId = context.actor.kind === "user" ? context.actor.user.id : "",
  ) => {
    const query = new URLSearchParams({ expectedUserId });
    const socket = new BunWebSocket(
      `ws://127.0.0.1:${server.port}/mailboxes/Mail01/drafts/${currentDraft.short_id}/document/socket?${query}`,
      {
        headers: { Cookie: cookie },
      },
    );
    sockets.add(socket);
    const messages: MailDraftDocumentMessage[] = [];
    socket.addEventListener("message", (event) => messages.push(mailDraftDocumentMessageSchema.parse(JSON.parse(String(event.data)))));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Socket did not upgrade"));
    });
    const send = (packet: unknown) => socket.send(JSON.stringify(packet));
    const wait = async (predicate: (packet: MailDraftDocumentMessage) => boolean, timeout = 5000) => {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return new Promise<MailDraftDocumentMessage>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("message", check);
          socket.removeEventListener("close", ended);
        };
        const check = () => {
          const found = messages.find(predicate);
          if (found) {
            cleanup();
            resolve(found);
          }
        };
        const ended = () => {
          cleanup();
          reject(new Error(`Socket ended before expected packet: ${JSON.stringify(messages)}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for packet: ${JSON.stringify(messages)}`));
        }, timeout);
        socket.addEventListener("message", check);
        socket.addEventListener("close", ended);
      });
    };
    const ready = async () => {
      send({ type: "replayRequest", payload: { docId: currentDraft.short_id, generation: null, fromCursor: null } });
      await wait((packet) => packet.type === "replayReady");
    };
    return { socket, messages, send, wait, ready };
  };

  const publish = (client: Awaited<ReturnType<typeof connect>>, base: Awaited<ReturnType<typeof read>>, update: Uint8Array) => {
    client.send({
      type: "syncPublish",
      payload: { docId: currentDraft.short_id, generation: base.generation, baseCursor: base.durable.cursor, payload: toBase64(update) },
    });
  };

  test("room joins and rejects a packet targeting another draft", async () => {
    await draft();
    const client = await connect();
    await client.ready();
    client.send({ type: "syncPublish", payload: { docId: newShortId(), generation: "1", baseCursor: null, payload: "AAA=" } });
    await client.wait((packet) => packet.type === "error");
    expect((await read()).durable.content.body).toBe("Original");
  });

  test("SQL budget: real room edits, delivery to another socket and cursor updates each cost zero", async () => {
    const meter = await meterSql();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    try {
      // Fixtures and join are deliberately outside the hot-path windows.
      const created = await draft();
      const base = await read();
      Y.applyUpdate(doc, base.fresh.state);
      const publisher = await connect();
      await publisher.ready();
      const receiver = await connect();
      await receiver.ready();
      const update = await createDraftRevisionUpdate(
        base.fresh.state,
        { ...base.fresh.content, body: "Metered edit" },
        { deadline: Date.now() + 10000 },
      );
      const delivered = (packet: MailDraftDocumentMessage) =>
        packet.type === "syncPush" && !packet.payload.snapshot && packet.payload.updates.some((u) => u.payload === toBase64(update));
      const statements = await meter.during(async () => {
        publish(publisher, base, update);
        await Promise.all([publisher.wait(delivered), receiver.wait(delivered)]);
      });
      expect({ perEdit: statements.length, perDelivery: statements.length, statements }).toEqual({
        perEdit: 0,
        perDelivery: 0,
        statements: [],
      });
      Y.applyUpdate(doc, update);
      const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText("codemirror"), 1));
      awareness.setLocalState({ cursor: { anchor: position, head: position } });
      const cursorStatements = await meter.during(async () => {
        publisher.send({
          type: "awarenessPublish",
          payload: {
            docId: created.short_id,
            generation: base.generation,
            payload: toBase64(encodeAwarenessUpdate(awareness, [doc.clientID])),
          },
        });
        await receiver.wait((packet) => packet.type === "awarenessPush" && packet.payload.updates.some((u) => u.payload !== "AA=="));
      });
      expect({ perAwareness: cursorStatements.length, statements: cursorStatements }).toEqual({ perAwareness: 0, statements: [] });
    } finally {
      for (const socket of sockets) socket.close();
      await stopMailDraftConnections();
      awareness.destroy();
      doc.destroy();
      await meter.close();
    }
  });

  test("JetStream echo precedes lazy SQL and a snapshot projects body, headers, adoption and provider export", async () => {
    await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const update = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...base.fresh.content, body: "Human text", subject: "Lazy subject" },
      { deadline: Date.now() + 10000 },
    );
    publish(client, base, update);
    await client.wait(
      (packet) =>
        packet.type === "syncPush" && !packet.payload.snapshot && packet.payload.updates.some((u) => u.payload === toBase64(update)),
    );
    const [before] = await sql<
      { body_markdown: string; subject: string }[]
    >`SELECT body_markdown, subject FROM mail.drafts WHERE id = ${currentDraft.id}::uuid`;
    expect(before).toEqual({ body_markdown: "Original", subject: "Subject" });
    await flushDraftDocumentSnapshot(currentDraft.id);
    const [after] = await sql<
      { body_markdown: string; subject: string; adopted_at: Date | null }[]
    >`SELECT body_markdown, subject, adopted_at FROM mail.drafts WHERE id = ${currentDraft.id}::uuid`;
    expect(after?.body_markdown).toBe("Human text");
    expect(after?.subject).toBe("Lazy subject");
    expect(after?.adopted_at).not.toBeNull();
    const projections = await sql`SELECT id FROM mail.draft_provider_snapshots WHERE draft_id = ${currentDraft.id}::uuid`;
    expect(projections.length).toBeGreaterThan(0);
  });

  test("identity events skip another account and close this account's revoked session", async () => {
    if (otherContext.actor.kind !== "user" || context.actor.kind !== "user") throw new Error("User fixture required");
    const coreLive = defineLive({ appId: "core", event: z.object({ type: z.literal("identity.access.changed"), userId: z.string() }) });
    const stopCore = await startLiveOutbox("core");
    const previous = activeSession;
    let stopObserved = () => {};
    try {
      const deadline = Date.now() + 5000;
      while ((await sql`SELECT 1 FROM events.outbox WHERE app_id = 'core' AND kind = 'live' AND next_attempt_at <= now() LIMIT 1`).length) {
        if (Date.now() > deadline) throw new Error("Core fixture outbox did not drain");
        await Bun.sleep(10);
      }
      await draft();
      const client = await connect();
      await client.ready();
      const before = authenticationReads;
      const observed = Promise.withResolvers<void>();
      stopObserved = subscribeIdentityAccessChanged(() => observed.resolve(), { userId: otherContext.actor.user.id });
      await sql.begin((tx) =>
        coreLive.publish(tx, {
          key: "identity.scope-fixture",
          data: { type: "identity.access.changed", userId: otherContext.actor.kind === "user" ? otherContext.actor.user.id : "" },
        }),
      );
      coreLive.wake();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          observed.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Core identity event was not delivered")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(authenticationReads).toBe(before);
      activeSession = null;
      await sql.begin((tx) =>
        coreLive.publish(tx, {
          key: "identity.scope-fixture",
          data: { type: "identity.access.changed", userId: context.actor.kind === "user" ? context.actor.user.id : "" },
        }),
      );
      coreLive.wake();
      const message = await client.wait((packet) => packet.type === "error");
      expect(message.type === "error" && message.payload.code).toBe("SESSION_EXPIRED");
    } finally {
      activeSession = previous;
      stopObserved();
      await stopCore?.();
    }
  });

  test("event-only grant revocation closes an existing socket", async () => {
    await draft();
    const client = await connect();
    await client.ready();
    await sql`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid AND access_id IN
      (SELECT id FROM auth.access WHERE user_id = ${context.accessSubject.type === "user" ? context.accessSubject.userId : ""}::uuid)`;
    mailLive.wake();
    const message = await client.wait((packet) => packet.type === "error");
    expect(message.type === "error" && message.payload.code).toBe("ACCESS_DENIED");
    // Restore fixture ownership for later tests, using the other manager.
    await sql`INSERT INTO mail.mailbox_access(mailbox_id, access_id)
      SELECT ${mailboxId}::uuid, id FROM auth.access WHERE user_id = ${context.accessSubject.type === "user" ? context.accessSubject.userId : ""}::uuid AND permission = 'admin'
      ON CONFLICT DO NOTHING`;
    mailLive.wake();
  });

  for (const change of ["assignment removed", "draft moved"])
    test(`assigned-only editor joins its conversation and closes when ${change}`, async () => {
      await draft();
      if (!activeSession || otherContext.actor.kind !== "user") throw new Error("Second session fixture missing");
      const previous = activeSession;
      const other = otherContext.actor.user;
      const [grant] = await sql<{ access_id: string }[]>`DELETE FROM mail.mailbox_access
        WHERE mailbox_id = ${mailboxId}::uuid AND access_id IN (SELECT id FROM auth.access WHERE user_id = ${other.id}::uuid)
        RETURNING access_id`;
      if (!grant) throw new Error("Missing fixture grant");
      const conversation = crypto.randomUUID(),
        targetConversation = crypto.randomUUID(),
        source = crypto.randomUUID();
      try {
        await sql`INSERT INTO mail.mailbox_assigned_access(mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${grant.access_id}::uuid)`;
        await sql`INSERT INTO mail.conversations(id, short_id, mailbox_id, latest_message_at)
          VALUES (${conversation}::uuid, ${newShortId()}, ${mailboxId}::uuid, '2026-11-12T12:00:00Z')`;
        await sql`INSERT INTO mail.conversations(id, short_id, mailbox_id, latest_message_at)
          VALUES (${targetConversation}::uuid, ${newShortId()}, ${mailboxId}::uuid, '2026-11-12T12:00:00Z')`;
        await sql`INSERT INTO mail.message_contents(id, short_id, mailbox_id, subject, internal_date, content_hash)
          VALUES (${source}::uuid, ${newShortId()}, ${mailboxId}::uuid, 'Assigned draft', '2026-11-12T12:00:00Z', ${(change === "draft moved" ? "b" : "a").repeat(64)})`;
        await sql`INSERT INTO mail.conversation_messages(conversation_id, message_id, position) VALUES (${conversation}::uuid, ${source}::uuid, 0)`;
        await sql`UPDATE mail.drafts SET intent = 'reply', conversation_id = ${conversation}::uuid,
          source_message_id = ${source}::uuid WHERE id = ${currentDraft.id}::uuid`;
        requestContext = otherContext;
        activeSession = { ...previous, user: other, data: { ...previous.data, userId: other.id } };
        const denied = await connect(`session_token=${token}`, other.id);
        denied.send({ type: "replayRequest", payload: { docId: currentDraft.short_id, generation: null, fromCursor: null } });
        expect(await denied.wait((packet) => packet.type === "error")).toMatchObject({
          type: "error",
          payload: { code: "ACCESS_DENIED" },
        });
        await sql`INSERT INTO mail.conversation_assignees(conversation_id, user_id) VALUES (${conversation}::uuid, ${other.id}::uuid)`;
        const allowed = await connect(`session_token=${token}`, other.id);
        await allowed.ready();
        if (change === "assignment removed")
          await sql`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${conversation}::uuid`;
        else await sql`UPDATE mail.drafts SET conversation_id = ${targetConversation}::uuid WHERE id = ${currentDraft.id}::uuid`;
        mailLive.wake();
        expect(await allowed.wait((packet) => packet.type === "error")).toMatchObject({
          type: "error",
          payload: { code: "ACCESS_DENIED" },
        });
      } finally {
        activeSession = previous;
        requestContext = context;
        await stopMailDraftConnections();
        await sql`DELETE FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid AND access_id = ${grant.access_id}::uuid`;
        await sql`INSERT INTO mail.mailbox_access(mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${grant.access_id}::uuid)`;
      }
    });
  const persistedBody = async (client: Awaited<ReturnType<typeof connect>>, body: string) => {
    await client.wait((packet) => packet.type === "syncPush" && !packet.payload.snapshot);
    await flushDraftDocumentSnapshot(currentDraft.id);
    expect((await read()).durable.content.body).toBe(body);
  };

  test("bounded reconnect storm preserves every admitted edit and replayed input is idempotent", async () => {
    await draft();
    const initial = await read();
    const local = new Y.Doc();
    local.clientID = 101;
    Y.applyUpdate(local, initial.durable.state);
    try {
      let expected = "Original";
      for (let index = 0; index < 8; index++) {
        const client = await connect();
        await client.ready();
        const base = await read();
        Y.applyUpdate(local, base.durable.state);
        const text = ` [${index}]`;
        local.getText("codemirror").insert(local.getText("codemirror").length, text);
        expected += text;
        const update = Y.encodeStateAsUpdate(local);
        publish(client, base, update);
        await persistedBody(client, expected);
        // A lost response may make a tab resend the same admitted identities on reconnect.
        client.socket.close();
        await stopMailDraftConnections();
        const retried = value(
          await acceptDraftDocumentUpdate({
            context,
            mailboxId,
            draftId: currentDraft.id,
            generation: base.generation,
            baseCursor: base.durable.cursor,
            update,
          }),
        );
        expect(retried.status).toBe("accepted");
      }
      const final = await read();
      expect(final.durable.content.body).toBe(expected);
      expect(Buffer.from(final.fresh.state)).toEqual(Buffer.from(final.durable.state));
    } finally {
      local.destroy();
    }
  }, 30_000);

  test("full stream rejection exposes a stable retry error while the exact local input remains recoverable", async () => {
    await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const local = new Y.Doc();
    local.clientID = 103;
    Y.applyUpdate(local, base.durable.state);
    local.getText("codemirror").insert(0, "Unsent ");
    const update = Y.encodeStateAsUpdate(local);
    // Sync creates a new handle per topic() call, including inside withStore().
    // Reject the real admission's publication, not an unused sibling handle.
    const rejected = new StoreFullError("Fixture: reject full stream");
    const sync = getProcessSync();
    const topic = sync.topic.bind(sync);
    let rejectedPublications = 0;
    const publications: { mockRestore(): void }[] = [];
    const handles = spyOn(sync, "topic").mockImplementation(<T>(config: TopicConfig) => {
      const handle = topic<T>(config);
      if (config.id === mailDraftDocumentLog.id) {
        const publish = handle.publish.bind(handle);
        publications.push(
          spyOn(handle, "publish").mockImplementation((input) => {
            if (input.tenantId === currentDraft.id && rejectedPublications === 0) {
              rejectedPublications++;
              return Promise.reject(rejected);
            }
            return publish(input);
          }),
        );
      }
      return handle;
    });
    try {
      try {
        publish(client, base, update);
        const error = await client.wait((packet) => packet.type === "error");
        expect(rejectedPublications).toBe(1);
        expect(error).toMatchObject({ type: "error", payload: { code: "STORAGE_EXHAUSTED" } });
        expect(error.type === "error" && error.payload.message).toContain("retry");
        expect(decode(Y.encodeStateAsUpdate(local)).body).toBe("Unsent Original");
        const unchanged = await read();
        expect(unchanged.durable.content.body).toBe("Original");
        expect(unchanged.durable.cursor).toBe(base.durable.cursor);
        expect(unchanged.fresh.content.body).toBe("Original");
        expect(client.messages.some((packet) => packet.type === "syncPush" && !packet.payload.snapshot)).toBe(false);
      } finally {
        handles.mockRestore();
        for (const publication of publications) publication.mockRestore();
      }
      const retry = await connect();
      await retry.ready();
      publish(retry, base, update);
      await persistedBody(retry, "Unsent Original");
      expect((await read()).durable.content.body).toBe("Unsent Original");
    } finally {
      local.destroy();
    }
  }, 15_000);

  test("socket server restart resynchronizes committed state and admits offline edits without loss", async () => {
    await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const local = new Y.Doc();
    local.clientID = 102;
    Y.applyUpdate(local, base.durable.state);
    try {
      local.getText("codemirror").insert(8, " before");
      publish(client, base, Y.encodeStateAsUpdate(local));
      await persistedBody(client, "Original before");
      await stopMailDraftConnections();
      await server.stop(true);
      // Document service handles are transaction-scoped; shutdown leaves no cached document to reuse.
      local.getText("codemirror").insert(local.getText("codemirror").length, " offline");
      startServer();
      const restarted = await connect();
      await restarted.ready();
      const restored = await read();
      expect(restored.durable.content.body).toBe("Original before");
      Y.applyUpdate(local, restored.durable.state);
      publish(restarted, restored, Y.encodeStateAsUpdate(local));
      await persistedBody(restarted, "Original before offline");
      expect((await read()).fresh.content.body).toBe("Original before offline");
    } finally {
      local.destroy();
    }
  }, 15_000);

  test("reconnect after switching A to B refuses A's expected account before opening the document", async () => {
    await draft();
    const first = await connect();
    await first.ready();
    first.socket.close();
    await stopMailDraftConnections();
    const previous = activeSession;
    if (!previous || otherContext.actor.kind !== "user") throw new Error("Second session fixture missing");
    const other = otherContext.actor.user;
    requestContext = otherContext;
    activeSession = { ...previous, user: other, data: { ...previous.data, userId: other.id } };
    const reads = spyOn(draftDocumentService, "readDraftDocument");
    const writes = spyOn(draftDocumentService, "acceptDraftDocumentUpdate");
    try {
      // Same fixed URL that the provider retained from SSR A.
      await expect(connect()).rejects.toThrow("Socket did not upgrade");
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      const url = `http://127.0.0.1:${server.port}/mailboxes/Mail01/drafts/${currentDraft.short_id}/document/socket`;
      for (const query of ["", `?expectedUserId=${context.actor.kind === "user" ? context.actor.user.id : ""}`]) {
        const refused = await fetch(`${url}${query}`, { headers: { Cookie: `session_token=${token}` } });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: "DRAFT_ACCOUNT_MISMATCH" });
      }
      const second = await connect(`session_token=${token}`, other.id);
      await second.ready(); // proves this was an identity mismatch, not missing domain permission
    } finally {
      reads.mockRestore();
      writes.mockRestore();
      activeSession = previous;
      requestContext = context;
    }
  });

  test("awareness uses broker-unique IDs and authenticated identity, then removes it on close", async () => {
    const created = await draft();
    const publisher = await connect();
    await publisher.ready();
    const receiver = await connect();
    await receiver.ready();
    const sourceDoc = new Y.Doc();
    sourceDoc.clientID = 333;
    const targetDoc = new Y.Doc();
    targetDoc.clientID = 444;
    const source = new Awareness(sourceDoc),
      target = new Awareness(targetDoc);
    try {
      source.setLocalState({ user: { userId: "victim", name: "Administrator", color: "red" }, cursor: null });
      publisher.send({
        type: "awarenessPublish",
        payload: { docId: created.short_id, generation: "1", payload: toBase64(encodeAwarenessUpdate(source, [sourceDoc.clientID])) },
      });
      const packet = await receiver.wait(
        (message) => message.type === "awarenessPush" && message.payload.updates.some((update) => update.payload !== "AA=="),
      );
      if (packet.type !== "awarenessPush") throw new Error("Awareness packet missing");
      const frame = packet.payload.updates[0]!;
      applyAwarenessUpdate(target, fromBase64(frame.payload), "remote");
      const allocated = [...target.getStates().keys()].find((id) => id >= 2 ** 32);
      expect(allocated).toBeDefined();
      if (allocated === undefined || context.actor.kind !== "user") throw new Error("Trusted allocation missing");
      expect(target.getStates().get(allocated)).toMatchObject({
        writerId: 333,
        user: { userId: context.actor.user.id, name: "Socket Person" },
        cursor: null,
      });
      expect(target.getStates().has(333)).toBe(false);
      publisher.socket.close();
      const removal = await receiver.wait(
        (message) =>
          message.type === "awarenessPush" &&
          message.payload.updates.some(
            (update) => update.originPeerId === frame.originPeerId && update.payload !== frame.payload && update.payload !== "AA==",
          ),
      );
      if (removal.type !== "awarenessPush") throw new Error("Awareness removal missing");
      applyAwarenessUpdate(target, fromBase64(removal.payload.updates[0]!.payload), "remote");
      expect(target.getStates().has(allocated)).toBe(false);
    } finally {
      source.destroy();
      target.destroy();
      sourceDoc.destroy();
      targetDoc.destroy();
    }
  });

  test("a cursor flood waits as one message, keeps the socket open and lets the edit through", async () => {
    const created = await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const sourceDoc = new Y.Doc();
    sourceDoc.clientID = 555;
    const source = new Awareness(sourceDoc);
    try {
      const cursorMessage = () => {
        // Each state change raises the awareness clock, like every pointer move of a selection drag.
        source.setLocalState({ cursor: null });
        return {
          type: "awarenessPublish",
          payload: { docId: created.short_id, generation: base.generation, payload: toBase64(encodeAwarenessUpdate(source, [555])) },
        };
      };
      // Far more than the 200 queued messages a socket accepts, sent at once with one edit in the middle.
      for (let index = 0; index < 300; index++) client.send(cursorMessage());
      const bytes = await createDraftRevisionUpdate(
        base.fresh.state,
        { ...created.content, body: "Typed during a drag" },
        { deadline: Date.now() + 5000 },
      );
      client.send({
        type: "syncPublish",
        payload: { docId: created.short_id, generation: base.generation, baseCursor: base.fresh.cursor, payload: toBase64(bytes) },
      });
      for (let index = 0; index < 300; index++) client.send(cursorMessage());
      const echo = await client.wait((packet) => packet.type === "syncPush" && !packet.payload.snapshot);
      expect(echo.type === "syncPush" && echo.payload.updates[0]?.payload).toBe(toBase64(bytes));
      await persistedBody(client, "Typed during a drag");
      expect(client.messages.some((packet) => packet.type === "error" && packet.payload.code === "BACKPRESSURE")).toBe(false);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      source.destroy();
      sourceDoc.destroy();
    }
  });

  test("app-session cookie uses the same trusted session and replay contract", async () => {
    await draft();
    const previous = activeSession;
    if (!previous) throw new Error("Session fixture missing");
    activeSession = { ...previous, data: { ...previous.data, kind: "app", deviceId: "fixture-phone" } };
    try {
      const client = await connect(`pwa_session=${token}`);
      await client.ready();
      expect(client.messages.at(-1)?.type).toBe("replayReady");
    } finally {
      activeSession = previous;
    }
  });

  test("malformed history recovery preserves valid updates, unresolved dependencies and the original base", async () => {
    await draft();
    const base = await read();
    const valid = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...base.fresh.content, body: "Recovered valid text" },
      { deadline: Date.now() + 5000 },
    );
    const missing = new Y.Doc();
    missing.clientID = 991;
    missing.getText("codemirror").insert(0, "missing-parent");
    const vector = Y.encodeStateVector(missing);
    missing.getText("codemirror").insert(missing.getText("codemirror").length, "pending-child");
    const pending = Y.encodeStateAsUpdate(missing, vector);
    const topic = mailDraftDocumentLog.topic();
    const append = (payload: string) =>
      topic.publish({
        tenantId: currentDraft.id,
        data: {
          kind: "sync",
          payload,
          restoreRevision: base.generation,
          originNodeId: "fixture",
          originPeerId: null,
        },
      });
    try {
      await append(toBase64(valid));
      const poison = await append("AAAA");
      await append(toBase64(pending));
      await draftDocumentSnapshotStore.recover(
        currentDraft.id,
        new MalformedSharedTextEventError(currentDraft.id, poison.cursor, "fixture"),
        {},
      );
      const [row] = await sql<{ doc_state: Uint8Array; doc_history_complete: boolean; body_markdown: string }[]>`
        SELECT doc_state, doc_history_complete, body_markdown FROM mail.drafts WHERE id = ${currentDraft.id}::uuid`;
      expect(row?.doc_history_complete).toBe(false);
      expect(row?.body_markdown).toBe("Original");
      const recovered = new Y.Doc();
      try {
        Y.applyUpdate(recovered, row!.doc_state);
        expect(recovered.getText("codemirror").toString()).toBe("Recovered valid text");
        expect(recovered.store.pendingStructs).not.toBeNull();
        Y.applyUpdate(recovered, Y.encodeStateAsUpdate(missing));
        expect(recovered.store.pendingStructs).toBeNull();
        expect(recovered.getText("codemirror").toString()).toContain("pending-child");
      } finally {
        recovered.destroy();
      }
      const originals = await sql<{ state: Uint8Array }[]>`SELECT state FROM mail.draft_document_revisions
        WHERE draft_id = ${currentDraft.id}::uuid AND revision = ${base.revision}`;
      expect(Buffer.from(originals[0]!.state)).toEqual(Buffer.from(base.durable.state));
    } finally {
      missing.destroy();
    }
  });
  test("freeze survives pruning and a second live editor receives no edit ack", async () => {
    await draft();
    const base = await read();
    const publisher = await connect();
    await publisher.ready();
    const other = await connect();
    await other.ready();
    const frozen = await mailDraftRoom.freeze(currentDraft.id);
    if (!frozen) throw new Error("Missing frozen draft");
    await mailDraftDocumentLog.topic().prune({ through: frozen.cursor });
    const update = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...base.fresh.content, body: "Must not be acknowledged" },
      { deadline: Date.now() + 10000 },
    );
    publish(other, base, update);
    const refused = await other.wait((packet) => packet.type === "error");
    expect(refused.type).toBe("error");
    if (refused.type !== "error") throw new Error("Missing refusal");
    expect(["DOCUMENT_FROZEN", "RESYNC_REQUIRED"]).toContain(refused.payload.code);
    expect((await mailDraftDocumentLog.lifecycle!.get(currentDraft.id))?.value.state).toBe("frozen");
    for (const client of [publisher, other])
      expect(
        client.messages.some(
          (packet) => packet.type === "syncPush" && packet.payload.updates.some((entry) => entry.payload === toBase64(update)),
        ),
      ).toBe(false);
    const persisted = await draftDocumentSnapshotStore.load(currentDraft.id, {});
    expect(decode(persisted!.state!).body).toBe("Original");
    await mailDraftRoom.thaw(currentDraft.id, { freezeCursor: frozen.cursor });
  });
});
