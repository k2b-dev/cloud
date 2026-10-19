import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import {
  type ConnectorVerification,
  type ProviderConnectionInput,
  type RemoteFolder,
  unavailableProviderLimitSnapshot,
} from "../contracts";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { attachProviderBinding } from "./bindings";
import { imapSmtpConnector } from "./connectors";
import { mailboxLiveKeys } from "./live-channels";
import { createMailbox, updateMailbox } from "./mailboxes";
import { createProviderConnection, replaceProviderConnection, revokeProviderConnection } from "./provider-connections";
import { createSavedConversationView, deleteSavedConversationView, updateSavedConversationView } from "./saved-views";
import {
  createSenderIdentity,
  disableSenderIdentity,
  setupDefaultSender,
  updateSenderIdentity,
  verifySenderIdentity,
} from "./sender-identities";

const suite = suiteFor("database", "nats", "valkey");
type Update = { payload: { v: number; k: string; d: { conversationId: string | null } }; transaction: string };

const folders = (): RemoteFolder[] =>
  ["INBOX", "Sent", "Drafts"].map((path, index) => ({
    stableKey: `${path}:${index + 10}`,
    path,
    name: path,
    delimiter: "/",
    parentPath: null,
    role: index === 0 ? "inbox" : index === 1 ? "sent" : "drafts",
    subscribed: true,
    selectable: true,
    uidValidity: String(index + 10),
    uidNext: "1",
    highestModseq: "1",
    rights: ["read", "write_flags", "insert", "move", "delete_messages", "create_children", "delete_folder"],
    rightsSource: "acl",
  }));
const verification = (email: string): ConnectorVerification => ({
  authenticatedPrincipal: email,
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: true,
    qresync: true,
    move: true,
    uidplus: true,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: true,
    notify: false,
    quota: false,
    gmailExtensions: false,
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [{ id: email, name: email, locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] }],
});

// Like live.integration.test.ts, inspect the durable rows rather than starting an outbox publisher.
// Every case changes a different mailbox from the sentinel and checks both reader key sets.
suite("Mail frame writers invalidate open mailboxes", () => {
  let context: MailRequestContext;
  let userId = "";
  let sentinelId = "";
  const mailboxIds: string[] = [];
  const accessIds: string[] = [];
  let restore = () => {};

  beforeAll(async () => {
    await migrate();
    const uid = `mail-frame-${crypto.randomUUID()}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Frame owner', false) RETURNING id
    `;
    userId = user!.id;
    const owner: User = {
      id: userId,
      uid,
      provider: "local",
      profile: "user",
      displayName: "Frame owner",
      givenname: "Frame",
      sn: "Owner",
      mail: `${uid}@example.test`,
      roles: ["user"],
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroupIds: [],
      memberofGroup: [],
      manages: [],
      managesGroupIds: [],
    };
    context = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId },
      requestId: uid,
    };
    sentinelId = await mailbox();
  });

  beforeEach(() => {
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation(async (input) => verification(input.email));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => folders());
    const send = spyOn(imapSmtpConnector, "send").mockImplementation(async (_runtime, request) => ({
      response: "250 accepted",
      messageId: request.messageId,
      accepted: request.to.map((address) => address.address),
      rejected: [],
    }));
    restore = () => {
      verify.mockRestore();
      discover.mockRestore();
      send.mockRestore();
    };
  });
  afterEach(() => restore());

  afterAll(async () => {
    for (const id of mailboxIds) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      accessIds.push(...grants.map((row) => row.access_id));
      await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key IN (${id}, ${`${id}:assigned`})`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
    }
    for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const mailbox = async () => {
    const created = unwrap(await createMailbox(context, { name: `Frame ${mailboxIds.length}` }));
    mailboxIds.push(created.id);
    return created.id;
  };
  const input = (mailboxId: string): ProviderConnectionInput => ({
    name: "Frame account",
    email: `frame-${mailboxId}@example.test`,
    username: `frame-${mailboxId}@example.test`,
    imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
    secret: { kind: "password", password: "fixture-secret" },
  });
  const connected = async () => {
    const mailboxId = await mailbox();
    const connection = unwrap(await createProviderConnection({ context, mailboxId, input: input(mailboxId) })).connection;
    const binding = unwrap(await attachProviderBinding({ context, mailboxId, connectionId: connection.id }));
    return { mailboxId, connectionId: connection.id, bindingId: binding.id };
  };
  const identity = async (mailboxId: string) =>
    unwrap(
      await createSenderIdentity({
        context,
        mailboxId,
        input: {
          label: "Frame sender",
          displayName: "Sender",
          fromAddress: input(mailboxId).email,
          authenticationPolicy: { automation: "mailbox" },
        },
      }),
    );
  const pending = (mailboxId: string) => sql<Update[]>`
    SELECT payload, split_part(coalesce_key, ':', 1) AS transaction FROM events.outbox
    WHERE app_id = 'mail' AND kind = 'live' AND ordering_key IN (${mailboxId}, ${`${mailboxId}:assigned`}) ORDER BY seq
  `;
  const clear = async (mailboxId: string) => {
    for (const id of [mailboxId, sentinelId]) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key IN (${id}, ${`${id}:assigned`})`;
    }
  };
  const assertPair = (mailboxId: string, updates: Update[]) => {
    expect(updates.map(({ payload }) => payload)).toEqual([
      { v: 1, k: mailboxId, d: { conversationId: null } },
      { v: 1, k: `${mailboxId}:assigned`, d: { conversationId: null } },
    ]);
    expect(new Set(updates.map((row) => row.transaction)).size).toBe(1);
    for (const access of [
      { scope: "mailbox", permission: "read" },
      { scope: "assigned", permission: "read", userId },
    ] as const) {
      const keys = mailboxLiveKeys(mailboxId, access);
      expect(updates.filter(({ payload }) => keys.includes(payload.k))).toHaveLength(1);
    }
  };
  const change = async (mailboxId: string, write: () => Promise<unknown>) => {
    await clear(mailboxId);
    await write();
    assertPair(mailboxId, await pending(mailboxId));
    expect(await pending(sentinelId)).toEqual([]);
  };

  test("updateMailbox notifies both scopes, and a no-op stays quiet", async () => {
    const mailboxId = await mailbox();
    await change(mailboxId, async () => unwrap(await updateMailbox({ context, mailboxId, name: "Renamed", syncEnabled: false })));
    await clear(mailboxId);
    unwrap(await updateMailbox({ context, mailboxId, name: "Renamed", syncEnabled: false }));
    expect(await pending(mailboxId)).toEqual([]);
  });
  test("createSenderIdentity notifies both scopes", async () => {
    const mailboxId = await mailbox();
    await change(mailboxId, () => identity(mailboxId));
  });
  test("updateSenderIdentity notifies both scopes, and a no-op stays quiet", async () => {
    const mailboxId = await mailbox();
    const sender = await identity(mailboxId);
    const params = { context, mailboxId, senderIdentityId: sender.id, input: { displayName: "Changed" } };
    await change(mailboxId, async () => unwrap(await updateSenderIdentity(params)));
    await clear(mailboxId);
    unwrap(await updateSenderIdentity(params));
    expect(await pending(mailboxId)).toEqual([]);
  });
  test("disableSenderIdentity notifies both scopes; a repeated disable writes nothing", async () => {
    const mailboxId = await mailbox();
    const sender = await identity(mailboxId);
    const params = { context, mailboxId, senderIdentityId: sender.id };
    await change(mailboxId, async () => unwrap(await disableSenderIdentity(params)));
    await clear(mailboxId);
    expect((await disableSenderIdentity(params)).ok).toBe(false);
    expect(await pending(mailboxId)).toEqual([]);
  });

  for (const operation of ["create", "update", "delete"] as const)
    test(`private saved view ${operation} notifies both scopes without an activity or private content`, async () => {
      const mailboxId = await mailbox();
      const input = {
        scope: "private" as const,
        name: "Private subject",
        filter: { sort: "newest" as const, expression: { type: "all" as const } },
      };
      const view = operation === "create" ? null : unwrap(await createSavedConversationView({ context, mailboxId, input }));
      await change(mailboxId, async () => {
        if (operation === "create") return unwrap(await createSavedConversationView({ context, mailboxId, input }));
        if (operation === "update")
          return unwrap(
            await updateSavedConversationView({
              context,
              mailboxId,
              viewId: view!.id,
              input: { expectedRevision: view!.revision, name: "Private rename" },
            }),
          );
        return unwrap(await deleteSavedConversationView({ context, mailboxId, viewId: view!.id, expectedRevision: view!.revision }));
      });
      if (operation === "update") {
        await change(mailboxId, async () => {
          const unchanged = unwrap(
            await updateSavedConversationView({
              context,
              mailboxId,
              viewId: view!.id,
              input: { expectedRevision: view!.revision + 1, name: "Private rename", filter: input.filter },
            }),
          );
          expect(unchanged.revision).toBe(view!.revision + 2);
        });
      }
      const activity =
        await sql`SELECT id FROM mail.activity_events WHERE mailbox_id = ${mailboxId}::uuid AND target_type = 'saved_conversation_view'`;
      expect(activity).toHaveLength(0);
    });

  for (const operation of ["create", "replace", "revoke"] as const)
    test(`provider connection ${operation} invalidates the receiving address`, async () => {
      const fixture = operation === "create" ? { mailboxId: await mailbox(), connectionId: "" } : await connected();
      const { mailboxId, connectionId } = fixture;
      await change(mailboxId, async () => {
        if (operation === "create") return unwrap(await createProviderConnection({ context, mailboxId, input: input(mailboxId) }));
        if (operation === "replace") return unwrap(await replaceProviderConnection({ context, connectionId, input: input(mailboxId) }));
        return unwrap(await revokeProviderConnection(context, connectionId));
      });
      if (operation === "revoke") {
        await change(mailboxId, async () => unwrap(await revokeProviderConnection(context, connectionId)));
      }
    });

  for (const outcome of ["success", "rejection", "exception rejection"] as const)
    test(`sender verification ${outcome} invalidates both scopes`, async () => {
      const rejected = outcome !== "success";
      const f = await connected();
      const sender = await identity(f.mailboxId);
      const send = spyOn(imapSmtpConnector, "send").mockImplementation(async (_runtime, request) => {
        if (outcome === "exception rejection") throw new Error("Provider rejected verification");
        return {
          response: rejected ? "550 rejected" : "250 accepted",
          messageId: request.messageId,
          accepted: rejected ? [] : [input(f.mailboxId).email],
          rejected: rejected ? [input(f.mailboxId).email] : [],
        };
      });
      try {
        const verify = async () => {
          const result = await verifySenderIdentity({
            context,
            mailboxId: f.mailboxId,
            senderIdentityId: sender.id,
            bindingId: f.bindingId,
            verificationRecipient: input(f.mailboxId).email,
            savesSentAutomatically: true,
          });
          expect(result.ok).toBe(!rejected);
        };
        await change(f.mailboxId, verify);
        if (rejected) await change(f.mailboxId, verify);
      } finally {
        send.mockRestore();
      }
    });
  test("setupDefaultSender uses the identity and verification writers, each with one pair", async () => {
    const f = await connected();
    await clear(f.mailboxId);
    unwrap(await setupDefaultSender({ context, mailboxId: f.mailboxId, input: { bindingId: f.bindingId, savesSentAutomatically: true } }));
    const updates = await pending(f.mailboxId);
    expect(updates).toHaveLength(4);
    const transactions = [...new Set(updates.map((row) => row.transaction))];
    expect(transactions).toHaveLength(2);
    for (const transaction of transactions)
      assertPair(
        f.mailboxId,
        updates.filter((row) => row.transaction === transaction),
      );
    expect(await pending(sentinelId)).toEqual([]);
  });
});
