import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { getProcessSync, sql } from "@k2b/cloud";
import { auth } from "@k2b/cloud/server";
import { fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { StoreFullError, type TopicConfig } from "@k2b/sync";
import type { Server } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { prepareDraftSendBinding } from "../../test/fixtures/draft-send";
import { draftEditableContentInputSchema } from "../contracts";
import { createDraftRevisionUpdate, readDraftDocument as readModel } from "../lib/draft-document";
import { type MailDraftDocumentMessage, mailDraftDocumentMessageSchema } from "../lib/draft-document-protocol";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { createActorCommand } from "../service/commands";
import { reviewDraftComposeSafety } from "../service/compose-safety";
import * as draftDocumentService from "../service/draft-documents";
import {
  acceptDraftDocumentUpdate,
  lockDraftDocumentInTransaction,
  mailDraftDocumentLog,
  readDraftDocument,
} from "../service/draft-documents";
import { recoverDraftDocumentRest } from "../service/drafts";
import { createMailbox } from "../service/mailboxes";
import { stopMailDraftConnections, upgradeMailDraftDocumentSocket } from "./draft-document-socket";
import type { MailApiContext } from "./public-resource-boundary";

// Bun accepts headers; lib.dom's global constructor omits Bun's options overload.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

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
  let authentication: { mockRestore(): void };
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
    // cookie selection, socket transport, service admission, SQL fences and NATS remain real.
    authentication = spyOn(auth.session, "authenticate").mockImplementation(async (credential) =>
      credential === token ? activeSession : null,
    );
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
  });
  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.clear();
    await stopMailDraftConnections();
  });
  afterAll(async () => {
    await stopMailDraftConnections();
    await server?.stop(true);
    authentication?.mockRestore();
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
  const persistedBody = (client: Awaited<ReturnType<typeof connect>>, body: string) =>
    client.wait(
      (packet) =>
        packet.type === "syncPush" &&
        packet.payload.snapshot === true &&
        decode(fromBase64(packet.payload.updates[0]!.payload)).body === body,
    );

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
        expect(error).toMatchObject({ type: "error", payload: { code: "DRAFT_DOCUMENT_STREAM_FULL" } });
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

  test("sending while a socket types freezes only reviewed input and retains the late edit for recovery", async () => {
    await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const checked = value(
      await reviewDraftComposeSafety({ context, mailboxId, draftId: currentDraft.id, expectedRevision: base.revision }),
    );
    const local = new Y.Doc();
    Y.applyUpdate(local, base.durable.state);
    local.getText("codemirror").insert(8, " late");
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const original = draftDocumentService.acceptDraftDocumentUpdate;
    const admission = spyOn(draftDocumentService, "acceptDraftDocumentUpdate").mockImplementation(async (params) => {
      reached.resolve();
      await proceed.promise;
      return original(params);
    });
    // Bounded below the test timeout, so a socket that never reaches admission fails here and `finally` restores the spy.
    let admissionDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      publish(client, base, Y.encodeStateAsUpdate(local));
      await Promise.race([
        reached.promise,
        new Promise<never>((_, reject) => {
          admissionDeadline = setTimeout(() => reject(new Error("The socket update never reached admission")), 10_000);
        }),
      ]);
      clearTimeout(admissionDeadline);
      const command = value(
        await createActorCommand({
          context,
          mailboxId,
          input: {
            kind: "send",
            draftId: currentDraft.id,
            senderIdentityId: identity.id,
            expectedDraftRevision: base.revision,
            expectedContentHash: checked.contentHash,
            undoSeconds: 60,
            idempotencyKey: crypto.randomUUID(),
            safetyApproval: { revision: checked.revision, fingerprint: checked.fingerprint, warningIds: checked.warnings.map((w) => w.id) },
          },
        }),
      );
      proceed.resolve();
      await client.wait((packet) => packet.type === "error" && packet.payload.code === "RESYNC_REQUIRED");
      const recovered = value(
        await recoverDraftDocumentRest({
          context,
          mailboxId,
          draftId: currentDraft.id,
          generation: base.generation,
          clientId: crypto.randomUUID(),
          state: Y.encodeStateAsUpdate(local),
        }),
      );
      expect(recovered.status).toBe("recovered");
      if (recovered.status !== "recovered") throw new Error("Missing late input recovery");
      expect(recovered.draft.body).toBe("Original late");
      const [outbox] = await sql<{ draft_snapshot: { body: string } }[]>`
        SELECT draft_snapshot FROM mail.outbox_submissions WHERE command_id=${command.id}::uuid`;
      expect(outbox?.draft_snapshot.body).toBe("Original");
      expect(await sql`SELECT 1 FROM mail.outbox_submissions WHERE draft_id=${recovered.draft.id}::uuid`).toHaveLength(0);
    } finally {
      clearTimeout(admissionDeadline);
      proceed.resolve();
      admission.mockRestore();
      local.destroy();
    }
  }, 15_000);

  // R48 source-only guard: cookie B also has real write permission to the same draft.
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

  const waitForLock = async (holderPid: number, queryPart: string): Promise<number> => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const [waiter] = await sql<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          AND position(${queryPart} IN query) > 0
      `;
      if (waiter) return waiter.pid;
      await Bun.sleep(10);
    }
    throw new Error(`Socket never waited on the held row: ${queryPart}`);
  };

  // A test guard only: failure releases the fixture's blocker, then the caller
  // still awaits stop in finally. Production cleanup never races its SQL work.
  const stopWithinFixtureBudget = async (stopping: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopping,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Socket stop still waits on the held SQL row")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const expectTransactionEnded = async (holder: typeof sql, pid: number) => {
    // Inspect from the holder, so the pool cannot reuse the cancelled backend
    // for this observation and make our own SELECT look like unfinished work.
    const inspect = async () =>
      (
        await holder<{ state: string; xact_start: Date | null; blocked: boolean }[]>`
          SELECT state, xact_start, cardinality(pg_blocking_pids(pid)) > 0 AS blocked
          FROM pg_stat_activity WHERE pid = ${pid}
        `
      )[0];
    // Stop cancels the statement and closes the reservation; Postgres ends that
    // backend asynchronously, so it can still show "active" or an aborted
    // transaction for a moment. Wait until it is gone or idle, then assert.
    let backend = await inspect();
    const deadline = Date.now() + 1000;
    while (backend && backend.state !== "idle" && Date.now() < deadline) {
      await Bun.sleep(10);
      backend = await inspect();
    }
    // The pool may have closed the connection or returned it idle after ROLLBACK.
    if (backend) {
      expect(backend.blocked).toBe(false);
      expect(backend.state).toBe("idle");
      expect(backend.xact_start).toBeNull();
    }
  };

  // R44-3 integration witnesses. Source only until 2026-10-24 10:00 UTC.
  for (const direction of ["delivery", "admission"] as const) {
    test(`stop cancels ${direction} SQL and rolls back while another transaction still holds the row`, async () => {
      const created = await draft();
      const base = await read();
      const update = await createDraftRevisionUpdate(
        base.fresh.state,
        { ...created.content, body: "Blocked socket work" },
        { deadline: Date.now() + 5000 },
      );
      const client = await connect();
      await client.ready();
      let stopping: Promise<void> | undefined;
      try {
        await sql.begin(async (holder) => {
          await holder`SELECT id FROM mail.drafts WHERE id = ${created.id}::uuid FOR UPDATE`;
          const [backend] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("Missing blocker backend");
          if (direction === "delivery") {
            await mailDraftDocumentLog.topic().publish({
              tenantId: created.id,
              data: {
                kind: "sync",
                payload: toBase64(update),
                restoreRevision: base.generation,
                originNodeId: "fixture",
                originPeerId: null,
              },
            });
          } else {
            client.send({
              type: "syncPublish",
              payload: { docId: created.short_id, generation: base.generation, baseCursor: base.fresh.cursor, payload: toBase64(update) },
            });
          }
          const waiter = await waitForLock(backend.pid, direction === "delivery" ? "SELECT state, edit_mode" : "FOR UPDATE OF d");
          stopping = stopMailDraftConnections();
          await stopWithinFixtureBudget(stopping);
          await expectTransactionEnded(holder, waiter);
          expect(client.messages.some((packet) => packet.type === "syncPush" && !packet.payload.snapshot)).toBe(false);
          const [unchanged] = await holder<
            { revision: string | number }[]
          >`SELECT revision FROM mail.drafts WHERE id = ${created.id}::uuid`;
          expect(Number(unchanged?.revision)).toBe(base.revision);
        });
      } finally {
        // Even a failed regression releases the blocker before draining cleanup.
        await stopping;
      }
    });
  }

  test("stop cancels the initial service read after the first outbound fence", async () => {
    const created = await draft();
    const client = await connect();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const originalRead = draftDocumentService.readDraftDocument;
    const initialRead = spyOn(draftDocumentService, "readDraftDocument").mockImplementationOnce(async (params) => {
      entered.resolve();
      await proceed.promise;
      return originalRead(params);
    });
    let stopping: Promise<void> | undefined;
    try {
      client.send({ type: "replayRequest", payload: { docId: created.short_id, generation: null, fromCursor: null } });
      await entered.promise;
      await sql.begin(async (holder) => {
        await holder`SELECT id FROM mail.drafts WHERE id = ${created.id}::uuid FOR UPDATE`;
        const [backend] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error("Missing blocker backend");
        proceed.resolve();
        const waiter = await waitForLock(backend.pid, "FOR UPDATE OF d");
        stopping = stopMailDraftConnections();
        await stopWithinFixtureBudget(stopping);
        await expectTransactionEnded(holder, waiter);
        expect(client.messages.some((packet) => packet.type === "syncPush" || packet.type === "replayReady")).toBe(false);
        const [unchanged] = await holder<
          { doc_state: Uint8Array | null }[]
        >`SELECT doc_state FROM mail.drafts WHERE id = ${created.id}::uuid`;
        expect(unchanged?.doc_state).toBeNull();
      });
    } finally {
      proceed.resolve();
      initialRead.mockRestore();
      await stopping;
    }
  });

  test("snapshot, replay and ready use the public draft ID; accepted echo precedes full durable snapshot", async () => {
    const created = await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    expect(client.messages.map((packet) => packet.type)).toEqual(["syncPush", "replayReady"]);
    expect(client.messages.every((packet) => packet.payload.docId === created.short_id)).toBe(true);
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "Changed via socket" },
      { deadline: Date.now() + 5000 },
    );
    client.send({
      type: "syncPublish",
      payload: { docId: created.short_id, generation: base.generation, baseCursor: base.fresh.cursor, payload: toBase64(bytes) },
    });
    const echo = await client.wait((packet) => packet.type === "syncPush" && !packet.payload.snapshot);
    expect(echo.type === "syncPush" && echo.payload.updates[0]?.payload).toBe(toBase64(bytes));
    const persisted = await client.wait(
      (packet) =>
        packet.type === "syncPush" &&
        packet.payload.snapshot === true &&
        decode(fromBase64(packet.payload.updates[0]!.payload)).body === "Changed via socket",
    );
    expect(client.messages.indexOf(persisted)).toBeGreaterThan(client.messages.indexOf(echo));
    expect((await read()).durable.content.body).toBe("Changed via socket");
  });

  test("replay-only fresh state is never advertised as a durable snapshot", async () => {
    const created = await draft();
    const base = await read();
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "Retained only" },
      { deadline: Date.now() + 5000 },
    );
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context, mailboxId, draftId: created.id }));
      const broken = spyOn(locked.store, "save").mockRejectedValueOnce(new Error("Fixture persistence failure"));
      try {
        expect(value(await locked.accept({ generation: base.generation, baseCursor: base.fresh.cursor, update: bytes })).status).toBe(
          "pendingPersistence",
        );
      } finally {
        broken.mockRestore();
      }
    });
    const client = await connect();
    await client.ready();
    expect(client.messages.map((packet) => packet.type)).toEqual(["syncPush", "syncPush", "replayReady"]);
    const snapshot = client.messages[0];
    expect(snapshot?.type === "syncPush" && snapshot.payload.snapshot).toBe(true);
    if (snapshot?.type !== "syncPush") throw new Error("Snapshot missing");
    expect(decode(fromBase64(snapshot.payload.updates[0]!.payload)).body).toBe("Original");
    expect(client.messages[1]?.type === "syncPush" && client.messages[1].payload.snapshot).toBeUndefined();
    expect((await read()).fresh.content.body).toBe("Retained only");
    expect((await read()).durable.content.body).toBe("Original");
  });

  test("rolled-back freeze markers are inert; a committed freeze requires reopen", async () => {
    const created = await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const rolledBack = new Error("roll back fixture send");
    await expect(
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context, mailboxId, draftId: created.id }));
        value(await locked.freeze({ generation: base.generation }));
        throw rolledBack;
      }),
    ).rejects.toThrow("roll back fixture send");
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "After inert marker" },
      { deadline: Date.now() + 5000 },
    );
    expect(
      value(
        await acceptDraftDocumentUpdate({
          context,
          mailboxId,
          draftId: created.id,
          generation: base.generation,
          baseCursor: base.fresh.cursor,
          update: bytes,
        }),
      ).status,
    ).toBe("accepted");
    await client.wait((packet) => packet.type === "syncPush" && !packet.payload.snapshot);
    expect(client.messages.some((packet) => packet.type === "error")).toBe(false);
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context, mailboxId, draftId: created.id }));
      value(await locked.freeze({ generation: base.generation }));
    });
    expect(await client.wait((packet) => packet.type === "error")).toMatchObject({
      type: "error",
      payload: { code: "RESYNC_REQUIRED", reopen: true },
    });
  });

  test("fresh session reauthentication rejects a revoked session before write", async () => {
    const created = await draft();
    const client = await connect();
    await client.ready();
    const previous = activeSession;
    activeSession = null;
    try {
      client.send({ type: "awarenessPublish", payload: { docId: created.short_id, generation: "1", payload: "AA==" } });
      expect(await client.wait((packet) => packet.type === "error")).toMatchObject({ type: "error", payload: { code: "SESSION_EXPIRED" } });
    } finally {
      activeSession = previous;
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

  test("a generation changed under the SQL row lock cannot deliver queued old bytes", async () => {
    const created = await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "Obsolete generation" },
      { deadline: Date.now() + 5000 },
    );
    await sql.begin(async (db) => {
      await db`SELECT id FROM mail.drafts WHERE id = ${created.id}::uuid FOR UPDATE`;
      await mailDraftDocumentLog.topic().publish({
        tenantId: created.id,
        data: {
          kind: "sync",
          payload: toBase64(bytes),
          restoreRevision: base.generation,
          originNodeId: "fixture",
          originPeerId: null,
        },
      });
      await db`UPDATE mail.drafts SET doc_generation = doc_generation + 1 WHERE id = ${created.id}::uuid`;
    });
    expect(await client.wait((packet) => packet.type === "error")).toMatchObject({
      type: "error",
      payload: { code: "RESYNC_REQUIRED", reopen: true },
    });
    expect(client.messages.some((packet) => packet.type === "syncPush" && !packet.payload.snapshot)).toBe(false);
  });

  test("an idle socket reauthenticates without waiting for a browser write", async () => {
    await draft();
    const client = await connect();
    await client.ready();
    const previous = activeSession;
    activeSession = null;
    try {
      expect(await client.wait((packet) => packet.type === "error", 12500)).toMatchObject({
        type: "error",
        payload: { code: "SESSION_EXPIRED" },
      });
    } finally {
      activeSession = previous;
    }
  }, 15000);

  test("a packet cannot switch the authorized draft", async () => {
    await draft();
    const client = await connect();
    await client.ready();
    client.send({ type: "syncPublish", payload: { docId: "Other1", generation: "1", payload: "AAA=", baseCursor: null } });
    expect(await client.wait((packet) => packet.type === "error")).toMatchObject({ type: "error", payload: { code: "INVALID_PAYLOAD" } });
  });
  test("withdrawn write permission stops retained deliveries before exposing their bytes", async () => {
    const created = await draft();
    const base = await read();
    const client = await connect();
    await client.ready();
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "Must not be delivered" },
      { deadline: Date.now() + 5000 },
    );
    await sql`UPDATE auth.access SET permission = 'read' WHERE id IN (SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid)`;
    await mailDraftDocumentLog.topic().publish({
      tenantId: created.id,
      data: {
        kind: "sync",
        payload: toBase64(bytes),
        restoreRevision: base.generation,
        originNodeId: "fixture",
        originPeerId: null,
      },
    });
    expect(await client.wait((packet) => packet.type === "error")).toMatchObject({ type: "error", payload: { code: "ACCESS_DENIED" } });
    expect(client.messages.some((packet) => packet.type === "syncPush" && !packet.payload.snapshot)).toBe(false);
  });
});
