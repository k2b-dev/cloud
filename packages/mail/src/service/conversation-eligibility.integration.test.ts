import { expect, setSystemTime, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { ConnectorEnvelope } from "./connectors";
import { hydrateMessageFromSource } from "./message-hydration";
import { extractMessageProtocolFacts } from "./message-protocol";
import { ingestEnvelope } from "./sync-runtime";
import { getWorkflowSnapshot } from "./workflow-data";

// The Mail preload owns and drops the isolated database.
suiteFor(
  "database",
  "nats",
  "valkey",
)("automatic conversation eligibility", () => {
  test("unrelated senders start separate conversations without changing existing work state", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(database!.name).toMatch(/^mail_.*_test$/);
      const [mailbox] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes (short_id, name)
        VALUES (${newShortId()}, 'Conversation fixture') RETURNING id`;
      const mailboxId = mailbox!.id;
      const [other] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes (short_id, name)
        VALUES (${newShortId()}, 'Other mailbox') RETURNING id`;
      const setup = async (id: string) => {
        const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
          (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
          VALUES (${id}::uuid, '{}', '{}', ${"a".repeat(64)}, 'active') RETURNING id`;
        const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
          (short_id, remote_resource_id, stable_key, name, role, sync_status)
          VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
        await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
          VALUES (${newShortId()}, ${id}::uuid, 'support@example.test', 'Support')`;
        return { mailboxId: id, remoteResourceId: resource!.id, folderId: folder!.id };
      };
      const fixture = await setup(mailboxId);
      const otherFixture = await setup(other!.id);
      const rootId = "<known-message-id@customer.test>";
      let uid = 0;
      const envelope = (
        from: string,
        subject: string,
        reference: "none" | "inReplyTo" | "references",
        to = "support@example.test",
      ): ConnectorEnvelope => {
        uid += 1;
        const date = new Date(Date.UTC(2026, 10, 6, 10, uid));
        return {
          remoteRef: { folderStableKey: "inbox", uidValidity: "1", uid: String(uid), modseq: String(uid) },
          providerMessageId: null,
          providerThreadId: null,
          messageId: uid === 1 ? rootId : `<message-${uid}@unrelated.test>`,
          inReplyTo: reference === "inReplyTo" ? rootId : null,
          references: reference === "references" ? [rootId] : [],
          subject,
          sentAt: date,
          internalDate: date,
          sizeBytes: 512,
          flags: [],
          labels: [],
          addresses: { from: [{ name: from, address: from }], replyTo: [], to: [{ name: to, address: to }], cc: [], bcc: [] },
          mimeStructure: {},
        };
      };
      const conversationOf = async (id: string) => {
        const [row] = await sql<{ conversation_id: string }[]>`SELECT conversation_id::text
          FROM mail.conversation_messages WHERE message_id = ${id}::uuid`;
        return row!.conversation_id;
      };
      const ingest = (message: ConnectorEnvelope, target = fixture) => ingestEnvelope({ db: sql, ...target, message });
      const root = await ingest(envelope("customer@customer.test", "Contract", "none"));
      const conversationId = await conversationOf(root);
      await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = '2026-11-08T12:00:00Z'
        WHERE id = ${conversationId}::uuid`;
      const foreign = envelope("stranger@unrelated.test", "Entirely unrelated subject", "inReplyTo");
      const foreignId = await ingest(foreign);
      expect(await conversationOf(foreignId)).not.toBe(conversationId);
      const referencesOnly = await ingest(envelope("second@unrelated.test", "Another unrelated subject", "references"));
      expect(await conversationOf(referencesOnly)).not.toBe(conversationId);
      const sameSubject = await ingest(envelope("stranger2@unrelated.test", "Re: Contract", "inReplyTo"));
      expect(await conversationOf(sameSubject)).not.toBe(conversationId);
      const matchingReferences = await ingest(envelope("another@unrelated.test", "Re: Contract", "references"));
      expect(await conversationOf(matchingReferences)).not.toBe(conversationId);
      // Negative controls: no known reference, another mailbox, or no address overlap.
      const independent = await ingest(envelope("third@unrelated.test", "Contract", "none"));
      expect(await conversationOf(independent)).not.toBe(conversationId);
      const crossMailbox = await ingest(envelope("fourth@unrelated.test", "Unrelated", "inReplyTo"), otherFixture);
      expect(await conversationOf(crossMailbox)).not.toBe(conversationId);
      const noOverlap = await ingest(envelope("fifth@unrelated.test", "No overlap", "inReplyTo", "alias@different.test"));
      expect(await conversationOf(noOverlap)).not.toBe(conversationId);
      const [ref] = await sql<{ id: string }[]>`SELECT id::text FROM mail.remote_message_refs WHERE message_id = ${foreignId}::uuid`;
      const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: ref!.id });
      expect(snapshot!.source.message.fromAddress).toBe("stranger@unrelated.test");
      expect(snapshot!.preconditions.conversation!.id).toBe(await conversationOf(foreignId));
      expect(snapshot!.source.conversation!.workStatus).toBe("needs_action");
      const raw = [
        `Message-ID: ${foreign.messageId}`,
        `In-Reply-To: ${rootId}`,
        "From: Stranger <stranger@unrelated.test>",
        "To: Support <support@example.test>",
        "Subject: Entirely unrelated subject",
        `Date: ${foreign.sentAt!.toUTCString()}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Foreign sender supplied this body.",
      ].join("\r\n");
      await hydrateMessageFromSource({ messageId: foreignId, source: Readable.from([raw]) });
      const [state] = await sql<{ work_status: string; snoozed_until: Date | null }[]>`SELECT work_status, snoozed_until
        FROM mail.conversations WHERE id = ${conversationId}::uuid`;
      expect(state!.work_status).toBe("done");
      expect(state!.snoozed_until).toEqual(new Date("2026-11-08T12:00:00Z"));
    } finally {
      setSystemTime();
    }
  }, 30_000);
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("automatic conversation eligibility paths", () => {
  const setup = async () => {
    const [mailbox] = await sql<{ id: string }[]>`INSERT INTO mail.mailboxes (short_id, name)
      VALUES (${newShortId()}, 'Conversation eligibility') RETURNING id`;
    const mailboxId = mailbox!.id;
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}', '{}', ${"b".repeat(64)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    for (const address of ["support@example.test", "alias@example.test"]) {
      await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${address}, 'Support')`;
    }
    let sequence = 0;
    const address = (value: string) => ({ name: value, address: value });
    const message = (from: string, changes: Partial<ConnectorEnvelope> = {}): ConnectorEnvelope => {
      sequence += 1;
      return {
        remoteRef: { folderStableKey: "inbox", uidValidity: "1", uid: String(sequence), modseq: String(sequence) },
        providerMessageId: null,
        providerThreadId: null,
        messageId: `<eligibility-${sequence}-${mailboxId}@example.test>`,
        inReplyTo: null,
        references: [],
        subject: "Contract",
        sentAt: new Date("2026-11-01T10:00:00Z"),
        internalDate: new Date("2026-11-01T10:00:00Z"),
        sizeBytes: 512,
        flags: [],
        labels: [],
        addresses: { from: [address(from)], to: [address("support@example.test")], cc: [], bcc: [], replyTo: [] },
        mimeStructure: {},
        ...changes,
      };
    };
    const ingest = (message: ConnectorEnvelope) =>
      ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId: resource!.id,
        folderId: folder!.id,
        message,
      });
    const conversation = async (id: string) => {
      const [row] = await sql<{ conversation_id: string }[]>`SELECT conversation_id::text
        FROM mail.conversation_messages WHERE message_id = ${id}::uuid`;
      return row!.conversation_id;
    };
    return { message, ingest, conversation, address, mailboxId, resourceId: resource!.id };
  };

  for (const path of ["direct", "references", "reverse", "shared", "subject", "provider"] as const) {
    test(`${path} candidates admit recorded From/To/Cc/Reply-To senders and refuse unrelated senders`, async () => {
      for (const from of [
        "stranger@example.test",
        "hidden@example.test",
        "redirect@example.test",
        "CUSTOMER@EXAMPLE.TEST",
        "INVITED@EXAMPLE.TEST",
        "CC@EXAMPLE.TEST",
      ]) {
        const f = await setup();
        // These paths must enforce sender participation when an original is already stored,
        // even if its conversation link is temporarily absent during maintenance.
        if (path === "reverse" || path === "shared") {
          const parent = f.message("author@example.test", {
            messageId: "<missing-parent@example.test>",
            subject: "Original topic",
          });
          const parentId = await f.ingest(parent);
          await sql`DELETE FROM mail.conversation_messages WHERE message_id = ${parentId}::uuid`;
        }
        const root = f.message("customer@example.test", {
          providerThreadId: path === "provider" ? "native-thread" : null,
          inReplyTo: path === "shared" ? "<missing-parent@example.test>" : null,
          references: path === "shared" ? ["<missing-parent@example.test>"] : [],
        });
        root.addresses.to.push(f.address("invited@example.test"));
        root.addresses.cc.push(f.address("cc@example.test"));
        root.addresses.bcc.push(f.address("hidden@example.test"));
        root.addresses.replyTo.push(f.address("redirect@example.test"));
        const originalConversation = await f.conversation(await f.ingest(root));

        const next = f.message(from, {
          subject: "AW: Fwd: Re: Contract",
          internalDate: new Date(path === "reverse" ? "2026-10-31T10:00:00Z" : "2026-11-02T10:00:00Z"),
          inReplyTo: path === "direct" ? root.messageId : path === "shared" || path === "reverse" ? "<missing-parent@example.test>" : null,
          references: path === "references" ? [root.messageId!] : [],
          providerThreadId: path === "provider" ? "native-thread" : null,
        });
        // Newly asserted visible participants cannot establish the sender's membership.
        next.addresses.to.push(f.address("customer@example.test"));
        next.addresses.cc.push(f.address("invited@example.test"));
        next.addresses.replyTo.push(f.address("cc@example.test"));
        if (path === "reverse") {
          await sql`UPDATE mail.message_contents SET in_reply_to = ${next.messageId}
            WHERE mailbox_id = (SELECT mailbox_id FROM mail.conversations WHERE id = ${originalConversation}::uuid)
              AND message_id = ${root.messageId}`;
        }
        const id = await f.ingest(next);
        if (from === "stranger@example.test" || from === "hidden@example.test") {
          expect(await f.conversation(id)).not.toBe(originalConversation);
        } else {
          expect(await f.conversation(id)).toBe(originalConversation);
        }
      }
    });
  }

  test("stored references keep known senders threaded across changed and localized subjects", async () => {
    for (const path of ["direct", "provider"] as const) {
      const f = await setup();
      const root = f.message("customer@example.test", { providerThreadId: path === "provider" ? "native" : null });
      const conversation = await f.conversation(await f.ingest(root));
      for (const subject of [
        "Different",
        "",
        "Re:",
        "RV: Contract",
        "SV: Contract",
        "Antw: Contract",
        "RE : Contract",
        "[EXTERNAL] Re: Contract",
        "Re: [EXT] Contract",
        "[list] Re: Contract",
      ]) {
        const next = f.message("customer@example.test", {
          subject,
          inReplyTo: root.messageId,
          providerThreadId: path === "provider" ? "native" : null,
        });
        expect(await f.conversation(await f.ingest(next))).toBe(conversation);
      }
    }
  });

  test("own sent copies and aliases stay threaded in either sync order", async () => {
    for (const own of ["SUPPORT@EXAMPLE.TEST", "ALIAS@EXAMPLE.TEST"]) {
      for (const replyFirst of [false, true]) {
        const f = await setup();
        const original = f.message("customer@example.test");
        const reply = f.message(own, {
          subject: "Re: Contract",
          inReplyTo: original.messageId,
          references: [original.messageId!],
          internalDate: new Date("2026-11-02T10:00:00Z"),
        });
        reply.addresses.to = [f.address("customer@example.test")];
        const first = await f.ingest(replyFirst ? reply : original);
        const second = await f.ingest(replyFirst ? original : reply);
        expect(await f.conversation(second)).toBe(await f.conversation(first));
      }
    }
  });

  test("replies from a recipient of mail sent by staff stay threaded", async () => {
    for (const role of ["to", "cc", "bcc"] as const) {
      const f = await setup();
      const original = f.message("support@example.test");
      original.addresses[role].push(f.address("person@example.test"));
      const first = await f.ingest(original);
      const reply = f.message("PERSON@EXAMPLE.TEST", { subject: "AW: Contract", inReplyTo: original.messageId });
      expect(await f.conversation(await f.ingest(reply))).toBe(await f.conversation(first));
    }
  });

  test("an original from another author stays threaded when its reply synchronized first", async () => {
    for (const providerThreadId of [null, "native"]) {
      const f = await setup();
      const original = f.message("author@example.test", { providerThreadId });
      original.addresses.cc.push(f.address("person@example.test"));
      const reply = f.message("person@example.test", {
        providerThreadId,
        subject: "AW: Contract",
        inReplyTo: original.messageId,
        references: [original.messageId!],
        internalDate: new Date("2026-11-02T10:00:00Z"),
      });
      reply.addresses.to.push(f.address("author@example.test"));
      const first = await f.ingest(reply);
      const conversation = await f.conversation(first);
      expect(await f.conversation(await f.ingest(original))).toBe(conversation);
      expect(await f.ingest(reply)).toBe(first);
      expect(await f.conversation(first)).toBe(conversation);
    }
  });

  test("a known reference still requires a recorded sender alongside a missing shared parent", async () => {
    const f = await setup();
    const missing = "<not-synchronized@example.test>";
    const original = f.message("customer@example.test", { inReplyTo: missing, references: [missing] });
    const conversation = await f.conversation(await f.ingest(original));
    for (const header of ["inReplyTo", "references"] as const) {
      const next = f.message("stranger@example.test", {
        subject: "Re: Contract",
        inReplyTo: header === "inReplyTo" ? original.messageId : missing,
        references: header === "references" ? [missing, original.messageId!] : [missing],
      });
      expect(await f.conversation(await f.ingest(next))).not.toBe(conversation);
    }
  });

  test("a separate native conversation does not divert subsequent replies", async () => {
    for (const from of ["customer@example.test", "support@example.test"]) {
      for (const reference of ["direct", "references", "none"] as const) {
        const f = await setup();
        const root = f.message("customer@example.test", { providerThreadId: "native" });
        const original = await f.conversation(await f.ingest(root));
        const unrelated = f.message("stranger@example.test", {
          providerThreadId: "native",
          subject: "Re: Contract",
          inReplyTo: root.messageId,
          internalDate: new Date("2026-11-02T10:00:00Z"),
        });
        if (reference !== "none") unrelated.addresses.to.push(f.address("customer@example.test"));
        const separate = await f.conversation(await f.ingest(unrelated));
        expect(separate).not.toBe(original);
        const reply = f.message(from, {
          providerThreadId: "native",
          subject: "AW: Contract",
          inReplyTo: reference === "direct" ? root.messageId : null,
          references: reference === "references" ? [root.messageId!] : [],
          internalDate: new Date("2026-11-03T10:00:00Z"),
        });
        if (from === "support@example.test") reply.addresses.to = [f.address("customer@example.test")];
        expect(await f.conversation(await f.ingest(reply))).toBe(original);
      }
    }
  });

  test("repeat sync preserves existing links and never rewrites prior conversations", async () => {
    const f = await setup();
    const original = f.message("customer@example.test");
    const first = await f.ingest(original);
    const before = await f.conversation(first);
    const separate = f.message("stranger@example.test", { subject: "Re: Contract", inReplyTo: original.messageId });
    const second = await f.ingest(separate);
    const isolated = await f.conversation(second);
    expect(isolated).not.toBe(before);
    expect(await f.ingest(separate)).toBe(second);
    // Even a changed envelope cannot move an existing link.
    expect(await f.ingest({ ...separate, subject: "Changed", addresses: original.addresses })).toBe(second);
    expect(await f.conversation(second)).toBe(isolated);
    expect(await f.conversation(first)).toBe(before);
    const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.conversation_messages
      WHERE message_id = ANY(ARRAY[${first}::uuid, ${second}::uuid])`;
    expect(count!.count).toBe(2);
  });
  test("shared missing references never admit strangers or change prior work state", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      const f = await setup();
      const missing = "<external-start@customer.test>";
      const root = f.message("customer@customer.test", { subject: "Re: Contract", inReplyTo: missing, references: [missing] });
      const conversation = await f.conversation(await f.ingest(root));
      await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = '2026-11-20T12:00:00Z'
        WHERE id = ${conversation}::uuid`;
      const next = f.message("stranger@attacker.test", {
        subject: "Re: Contract",
        inReplyTo: missing,
        references: [missing],
        internalDate: new Date("2026-11-06T11:00:00Z"),
        sentAt: new Date("2026-11-06T11:00:00Z"),
      });
      const id = await f.ingest(next);
      expect(await f.conversation(id)).not.toBe(conversation);
      const raw = [
        `Message-ID: ${next.messageId}`,
        `In-Reply-To: ${missing}`,
        `References: ${missing}`,
        "From: Stranger <stranger@attacker.test>",
        "To: Support <support@example.test>",
        "Subject: Re: Contract",
        `Date: ${next.sentAt!.toUTCString()}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body.",
      ].join("\r\n");
      await hydrateMessageFromSource({ messageId: id, source: Readable.from([raw]) });
      const [state] = await sql<{ work_status: string; snoozed_until: Date | null }[]>`SELECT work_status, snoozed_until
        FROM mail.conversations WHERE id = ${conversation}::uuid`;
      expect(state!.work_status).toBe("done");
      expect(state!.snoozed_until).toEqual(new Date("2026-11-20T12:00:00Z"));
      const follow = f.message("stranger@attacker.test", {
        subject: "Re: Contract",
        inReplyTo: root.messageId,
        references: [root.messageId!],
      });
      expect(await f.conversation(await f.ingest(follow))).not.toBe(conversation);
    } finally {
      setSystemTime();
    }
  });

  test("stored shared-reference participants keep out-of-order replies together", async () => {
    for (const role of ["to", "cc", "replyTo"] as const) {
      const f = await setup();
      const root = f.message("customer@example.test", { inReplyTo: "<missing@example.test>", references: ["<missing@example.test>"] });
      root.addresses[role].push(f.address("invited@example.test"));
      const conversation = await f.conversation(await f.ingest(root));
      const reply = f.message("INVITED@EXAMPLE.TEST", {
        subject: "Re: Contract",
        inReplyTo: "<missing@example.test>",
        references: ["<missing@example.test>"],
      });
      expect(await f.conversation(await f.ingest(reply))).toBe(conversation);
    }
  });

  test("list identity keeps different list authors together", async () => {
    const f = await setup();
    const protocolFacts = extractMessageProtocolFacts((name) =>
      name === "list-id" ? "Development <dev.lists.example.test>" : name === "list-post" ? "<mailto:dev@lists.example.test>" : null,
    );
    const root = f.message("alice@one.test", { subject: "[dev] Release plan", protocolFacts });
    root.addresses.to = [f.address("dev@lists.example.test")];
    const conversation = await f.conversation(await f.ingest(root));
    let parent = root.messageId;
    for (const [from, subject] of [
      ["bob@two.test", "Re: [dev] Release plan"],
      ["alice@one.test", "Re: [dev] Release plan"],
      ["carol@three.test", "[dev] Re: Release plan"],
    ]) {
      const next = f.message(from!, {
        subject: subject!,
        protocolFacts: extractMessageProtocolFacts((name) =>
          name === "list-id" ? "<DEV.LISTS.EXAMPLE.TEST>" : name === "list-post" ? "<mailto:DEV@LISTS.EXAMPLE.TEST>" : null,
        ),
        inReplyTo: parent,
        references: [root.messageId!, parent!],
      });
      next.addresses.to = [f.address("dev@lists.example.test")];
      expect(await f.conversation(await f.ingest(next))).toBe(conversation);
      parent = next.messageId;
    }
    const otherList = f.message("outsider@example.test", {
      subject: "Re: [dev] Release plan",
      inReplyTo: root.messageId,
      protocolFacts: extractMessageProtocolFacts((name) => (name === "list-id" ? "<other.example.test>" : null)),
    });
    expect(await f.conversation(await f.ingest(otherList))).not.toBe(conversation);
  });

  test("other quoted conversations are tried after the preferred candidate rejects the sender", async () => {
    for (const providerThreadId of [null, "native"]) {
      const f = await setup();
      const root = f.message("alice@example.test", { providerThreadId });
      const original = await f.conversation(await f.ingest(root));
      const unrelated = f.message("bob@example.test", {
        providerThreadId,
        subject: "Re: Contract",
        inReplyTo: root.messageId,
        internalDate: new Date("2026-11-02T10:00:00Z"),
      });
      const other = await f.conversation(await f.ingest(unrelated));
      expect(other).not.toBe(original);
      const reply = f.message("alice@example.test", {
        providerThreadId,
        subject: "Changed topic",
        inReplyTo: unrelated.messageId,
        references: [root.messageId!, unrelated.messageId!],
        internalDate: new Date("2026-11-03T10:00:00Z"),
      });
      expect(await f.conversation(await f.ingest(reply))).toBe(original);
    }
  });

  test("contact-form Reply-To is a prior participant when the mailbox reply is not stored", async () => {
    const f = await setup();
    const root = f.message("noreply@forms.test", { subject: "Contact request" });
    root.addresses.replyTo = [f.address("visitor@home.test")];
    const original = await f.conversation(await f.ingest(root));
    const reply = f.message("VISITOR@HOME.TEST", {
      subject: "Re: Contact request",
      inReplyTo: "<own-missing@example.test>",
      references: [root.messageId!, "<own-missing@example.test>"],
    });
    expect(await f.conversation(await f.ingest(reply))).toBe(original);
  });

  test("subject fallback recognizes localized prefixes and leading list or gateway tags", async () => {
    for (const subject of [
      "RV: Contract",
      "SV: Contract",
      "Antw: Contract",
      "RE : Contract",
      "[EXTERNAL] Re: Contract",
      "Re: [EXT] Contract",
      "[list] Re: Contract",
    ]) {
      const f = await setup();
      const root = f.message("customer@example.test");
      const original = await f.conversation(await f.ingest(root));
      const reply = f.message("customer@example.test", { subject });
      expect(await f.conversation(await f.ingest(reply))).toBe(original);
    }
  });

  test("list identity requires a shared external posting address and preserves unrelated work state", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      for (const variant of ["reference", "subject", "group-post", "alias-post", "missing-recipient"] as const) {
        const f = await setup();
        const protocolFacts = extractMessageProtocolFacts((name) =>
          name === "list-id"
            ? "<support.example.test>"
            : name === "list-post" && variant === "group-post"
              ? "<mailto:support@example.test>"
              : name === "list-post" && variant === "alias-post"
                ? "<mailto:alias@example.test>"
                : null,
        );
        const root = f.message("customer@customer.test", { protocolFacts });
        if (variant === "missing-recipient") root.addresses.to.push(f.address("dev@lists.example.test"));
        if (variant === "group-post" || variant === "alias-post") root.addresses.cc.push(f.address("other@example.test"));
        const conversation = await f.conversation(await f.ingest(root));
        await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = '2026-11-20T12:00:00Z'
          WHERE id = ${conversation}::uuid`;
        const next = f.message("stranger@example.test", {
          protocolFacts,
          messageId: variant === "subject" ? null : `<list-next-${f.mailboxId}@example.test>`,
          subject: variant === "subject" ? "Re: Contract" : "Different topic",
          inReplyTo: variant === "subject" ? null : root.messageId,
          references: variant === "subject" ? [] : [root.messageId!],
          internalDate: new Date("2026-11-06T11:00:00Z"),
          sentAt: new Date("2026-11-06T11:00:00Z"),
        });
        if (variant === "subject") next.addresses.replyTo.push(f.address("customer@customer.test"));
        if (variant === "group-post" || variant === "alias-post") next.addresses.cc.push(f.address("other@example.test"));
        const id = await f.ingest(next);
        expect(await f.conversation(id)).not.toBe(conversation);
        const raw = [
          ...(next.messageId ? [`Message-ID: ${next.messageId}`] : []),
          ...(next.inReplyTo ? [`In-Reply-To: ${next.inReplyTo}`] : []),
          "From: Stranger <stranger@example.test>",
          "To: Support <support@example.test>",
          "List-Id: <support.example.test>",
          `Subject: ${next.subject}`,
          `Date: ${next.sentAt!.toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Body.",
        ].join("\r\n");
        await hydrateMessageFromSource({ messageId: id, source: Readable.from([raw]) });
        const [state] = await sql<{ work_status: string; snoozed_until: Date | null }[]>`SELECT work_status, snoozed_until
          FROM mail.conversations WHERE id = ${conversation}::uuid`;
        expect(state!.work_status).toBe("done");
        expect(state!.snoozed_until).toEqual(new Date("2026-11-20T12:00:00Z"));
      }
    } finally {
      setSystemTime();
    }
  });

  test("List-Post identifies an external posting address without visible list recipients", async () => {
    const f = await setup();
    const facts = extractMessageProtocolFacts((name) =>
      name === "list-id" ? "<dev.lists.example.test>" : name === "list-post" ? "<mailto:DEV@LISTS.EXAMPLE.TEST?subject=Post>" : null,
    );
    const root = f.message("alice@example.test", { protocolFacts: facts });
    const conversation = await f.conversation(await f.ingest(root));
    const next = f.message("bob@example.test", { protocolFacts: facts, inReplyTo: root.messageId, references: [root.messageId!] });
    expect(await f.conversation(await f.ingest(next))).toBe(conversation);
  });

  test("ticket identifiers remain distinct during subject fallback", async () => {
    const f = await setup();
    const first = f.message("help@vendor.test", { subject: "[Ticket#1001] Invoice question" });
    const conversation = await f.conversation(await f.ingest(first));
    const second = f.message("help@vendor.test", {
      subject: "[Ticket#2002] Re: Invoice question",
      inReplyTo: "<unknown@vendor.test>",
      references: ["<unknown@vendor.test>"],
    });
    expect(await f.conversation(await f.ingest(second))).not.toBe(conversation);
    const reply = f.message("help@vendor.test", { subject: "Re: [Ticket#1001] Invoice question" });
    expect(await f.conversation(await f.ingest(reply))).toBe(conversation);
  });

  test("newest-first contact-form sync admits an original quoted by the mailbox", async () => {
    const f = await setup();
    const form = f.message("noreply@forms.test", { subject: "Contact request", internalDate: new Date("2026-11-01T09:00:00Z") });
    form.addresses.replyTo = [f.address("visitor@home.test")];
    const own = f.message("support@example.test", {
      subject: "Re: Contact request",
      inReplyTo: form.messageId,
      references: [form.messageId!],
      internalDate: new Date("2026-11-01T10:00:00Z"),
    });
    own.addresses.to = [f.address("visitor@home.test")];
    const visitor = f.message("visitor@home.test", {
      subject: "Re: Contact request",
      inReplyTo: own.messageId,
      references: [form.messageId!, own.messageId!],
      internalDate: new Date("2026-11-01T11:00:00Z"),
    });
    const conversation = await f.conversation(await f.ingest(visitor));
    expect(await f.conversation(await f.ingest(own))).toBe(conversation);
    expect(await f.conversation(await f.ingest(form))).toBe(conversation);
  });

  test("a foreign stored reply cannot admit a previously unseen original", async () => {
    const f = await setup();
    const original = f.message("noreply@forms.test", { internalDate: new Date("2026-11-01T09:00:00Z") });
    original.addresses.replyTo = [f.address("visitor@home.test")];
    const reply = f.message("visitor@home.test", {
      subject: "Re: Contract",
      inReplyTo: original.messageId,
      references: [original.messageId!],
      internalDate: new Date("2026-11-01T10:00:00Z"),
    });
    const conversation = await f.conversation(await f.ingest(reply));
    expect(await f.conversation(await f.ingest(original))).not.toBe(conversation);
  });

  test("subject normalization does not backfill older stored subjects", async () => {
    const f = await setup();
    const root = f.message("customer@example.test", { subject: "[dev] Release plan" });
    const id = await f.ingest(root);
    const conversation = await f.conversation(id);
    await sql`UPDATE mail.message_contents SET normalized_subject = '[dev] release plan' WHERE id = ${id}::uuid`;
    const subjectOnly = f.message("customer@example.test", { subject: "Re: [dev] Release plan" });
    expect(await f.conversation(await f.ingest(subjectOnly))).not.toBe(conversation);
    const quoted = f.message("customer@example.test", {
      subject: "Re: [dev] Release plan",
      inReplyTo: root.messageId,
      references: [root.messageId!],
    });
    expect(await f.conversation(await f.ingest(quoted))).toBe(conversation);
    const [stored] = await sql<
      { normalized_subject: string }[]
    >`SELECT normalized_subject FROM mail.message_contents WHERE id = ${id}::uuid`;
    expect(stored!.normalized_subject).toBe("[dev] release plan");
  });

  test("automatic references examine at most ten distinct conversations including the preferred one", async () => {
    for (const eligibleRank of [10, 11]) {
      const f = await setup();
      const quoted: string[] = [];
      let expected: string | null = null;
      let newest: ConnectorEnvelope | null = null;
      for (let rank = 11; rank >= 1; rank -= 1) {
        const root = f.message(rank === eligibleRank ? "alice@example.test" : `person${rank}@example.test`, {
          internalDate: new Date(Date.UTC(2026, 10, 1, 10, 12 - rank)),
        });
        const conversation = await f.conversation(await f.ingest(root));
        if (rank === eligibleRank) expected = conversation;
        quoted.push(root.messageId!);
        if (rank === 1) newest = root;
      }
      // Repeated messages in the preferred conversation must not consume distinct slots.
      for (let i = 0; i < 12; i += 1) {
        const duplicate = f.message("person1@example.test", {
          inReplyTo: newest!.messageId,
          references: [newest!.messageId!],
          internalDate: new Date(Date.UTC(2026, 10, 1, 11, i)),
        });
        await f.ingest(duplicate);
        quoted.push(duplicate.messageId!);
      }
      const next = f.message("alice@example.test", {
        subject: "Changed subject",
        inReplyTo: newest!.messageId,
        references: quoted,
        internalDate: new Date("2026-11-02T10:00:00Z"),
      });
      const actual = await f.conversation(await f.ingest(next));
      if (eligibleRank === 10) expect(actual).toBe(expected!);
      else expect(actual).not.toBe(expected!);
    }
  });

  const hydrateEnvelope = async (id: string, message: ConnectorEnvelope) => {
    const list = message.protocolFacts?.list;
    await hydrateMessageFromSource({
      messageId: id,
      source: Readable.from([
        [
          ...(message.messageId ? [`Message-ID: ${message.messageId}`] : []),
          ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
          ...(message.references.length ? [`References: ${message.references.join(" ")}`] : []),
          `From: ${message.addresses.from.map((address) => address.address).join(", ")}`,
          `To: ${message.addresses.to.map((address) => address.address).join(", ")}`,
          ...(list?.id ? [`List-Id: ${list.id}`] : []),
          ...(list?.post.length ? [`List-Post: ${list.post.map((link) => `<${link}>`).join(", ")}`] : []),
          `Subject: ${message.subject}`,
          `Date: ${message.sentAt!.toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Ordinary message body.",
        ].join("\r\n"),
      ]),
    });
  };

  test("own replies only establish their direct original with a matching subject", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      for (const variant of [
        "reference-stored",
        "reference-recent",
        "reference-same-subject",
        "direct-changed-subject",
        "direct-empty-subject",
      ] as const) {
        const f = await setup();
        const missing = `<missing-${f.mailboxId}@example.test>`;
        const root = f.message("customer@example.test", { subject: "Re: Contract", inReplyTo: missing, references: [missing] });
        const conversation = await f.conversation(await f.ingest(root));
        const direct = variant.startsWith("direct");
        const own = f.message("support@example.test", {
          subject: "Re: Contract",
          inReplyTo: direct ? missing : root.messageId,
          references: [missing, root.messageId!],
          internalDate: new Date("2026-11-02T10:00:00Z"),
        });
        own.addresses.to = [f.address("customer@example.test")];
        expect(await f.conversation(await f.ingest(own))).toBe(conversation);
        await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = '2026-11-20T12:00:00Z'
          WHERE id = ${conversation}::uuid`;
        const incoming = f.message("stranger@example.test", {
          messageId: missing,
          subject: variant === "reference-same-subject" ? "Contract" : variant === "direct-empty-subject" ? "" : "Unrelated topic",
          inReplyTo: variant === "reference-recent" ? null : root.messageId,
          references: variant === "reference-recent" ? [] : [root.messageId!],
          internalDate: new Date("2026-11-06T11:00:00Z"),
          sentAt: new Date("2026-11-06T11:00:00Z"),
        });
        const id = await f.ingest(incoming);
        expect(await f.conversation(id)).not.toBe(conversation);
        await hydrateEnvelope(id, incoming);
        const [state] = await sql`SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${conversation}::uuid`;
        expect(state).toEqual({ work_status: "done", snoozed_until: new Date("2026-11-20T12:00:00Z") });
      }
    } finally {
      setSystemTime();
    }
  });

  test("list admission requires the same external List-Post on both messages", async () => {
    for (const variant of ["neither", "earlier-only", "incoming-only", "different"] as const) {
      const f = await setup();
      const facts = (post: string | null) =>
        extractMessageProtocolFacts((name) =>
          name === "list-id" ? "<dev.lists.example.test>" : name === "list-post" && post ? `<mailto:${post}>` : null,
        );
      const root = f.message("customer@example.test", {
        protocolFacts: facts(variant === "neither" || variant === "incoming-only" ? null : "dev@lists.example.test"),
      });
      root.addresses.cc = [f.address("colleague@example.test"), f.address("dev@lists.example.test")];
      const conversation = await f.conversation(await f.ingest(root));
      const next = f.message("stranger@example.test", {
        subject: "Unrelated topic",
        inReplyTo: root.messageId,
        protocolFacts: facts(
          variant === "neither" || variant === "earlier-only"
            ? null
            : variant === "different"
              ? "other@lists.example.test"
              : "dev@lists.example.test",
        ),
      });
      next.addresses.cc = [...root.addresses.cc];
      expect(await f.conversation(await f.ingest(next))).not.toBe(conversation);
    }
  });

  test("list-only replies join without changing status or snooze during hydration and repeat sync", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      for (const variant of ["group-alias", "public-list", "legitimate-list"] as const) {
        for (const workStatus of ["done", "waiting", "needs_action"] as const) {
          const f = await setup();
          const postingAddress = variant === "group-alias" ? "info@example.test" : "dev@lists.example.test";
          const facts = extractMessageProtocolFacts((name) =>
            name === "list-id" ? "<dev.lists.example.test>" : name === "list-post" ? `<mailto:${postingAddress}>` : null,
          );
          const root = f.message("customer@example.test", { protocolFacts: facts });
          root.addresses.to = [f.address(postingAddress)];
          const conversation = await f.conversation(await f.ingest(root));
          const snooze = "2026-11-20T12:00:00Z";
          await sql`UPDATE mail.conversations SET work_status = ${workStatus}, snoozed_until = ${snooze}::timestamptz
            WHERE id = ${conversation}::uuid`;
          const next = f.message(variant === "legitimate-list" ? "bob@example.test" : "stranger@example.test", {
            subject: variant === "group-alias" ? "Unrelated topic" : "Re: Contract",
            protocolFacts: facts,
            inReplyTo: root.messageId,
            internalDate: new Date("2026-11-06T10:00:00Z"),
            sentAt: new Date("2026-11-06T10:00:00Z"),
          });
          next.addresses.to = [f.address(postingAddress)];
          const id = await f.ingest(next);
          expect(await f.conversation(id)).toBe(conversation);
          const unchanged = async () => {
            const [state] = await sql`SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${conversation}::uuid`;
            expect(state).toEqual({ work_status: workStatus, snoozed_until: new Date(snooze) });
          };
          await unchanged();
          await hydrateEnvelope(id, next);
          await unchanged();
          expect(await f.ingest(next)).toBe(id);
          await unchanged();
          const [loaded] = await sql`SELECT hydration_status, plain_text FROM mail.message_contents WHERE id = ${id}::uuid`;
          expect(loaded!.hydration_status).toBe("complete");
          expect(loaded!.plain_text).toContain("Ordinary message body.");
          const followup = f.message(next.addresses.from[0]!.address, {
            subject: "Re: Contract",
            protocolFacts: facts,
            inReplyTo: next.messageId,
            internalDate: new Date("2026-11-06T11:00:00Z"),
            sentAt: new Date("2026-11-06T11:00:00Z"),
          });
          followup.addresses.to = [f.address(postingAddress)];
          const followupId = await f.ingest(followup);
          expect(await f.conversation(followupId)).toBe(conversation);
          await hydrateEnvelope(followupId, followup);
          await unchanged();
          const unlisted = f.message(next.addresses.from[0]!.address, {
            subject: "Re: Contract",
            inReplyTo: next.messageId,
            internalDate: new Date("2026-11-06T11:30:00Z"),
          });
          expect(await f.conversation(await f.ingest(unlisted))).not.toBe(conversation);
          const [activities] = await sql`SELECT count(*)::int AS count FROM mail.activity_events
            WHERE conversation_id = ${conversation}::uuid AND action = 'conversation.work_state_changed'`;
          expect(activities!.count).toBe(0);
        }
      }
    } finally {
      setSystemTime();
    }
  }, 60_000);

  test("realistic list headers preserve work state and do not establish ordinary participation", async () => {
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      for (const postingAddress of ["dev@lists.example.org", "info@example.test"]) {
        const f = await setup();
        const listId = postingAddress === "info@example.test" ? "Info <info.example.test>" : "Dev <dev.lists.example.org>";
        const facts = extractMessageProtocolFacts((name) =>
          name === "list-id" ? listId : name === "list-post" ? `<mailto:${postingAddress}>` : null,
        );
        const root = f.message("alice@example.test", { subject: "[dev] Plan", protocolFacts: facts });
        root.addresses.to = [f.address(postingAddress)];
        const conversation = await f.conversation(await f.ingest(root));
        const snooze = new Date("2026-11-20T12:00:00Z");
        await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = ${snooze} WHERE id = ${conversation}::uuid`;
        for (const subject of ["Re: [dev] Plan", "Unrelated subject"]) {
          const reply = f.message("new-author@example.test", { subject, protocolFacts: facts, inReplyTo: root.messageId });
          reply.addresses.to = [f.address(postingAddress)];
          const id = await f.ingest(reply);
          expect(await f.conversation(id)).toBe(conversation);
          const [link] = await sql`SELECT added_by FROM mail.conversation_messages WHERE message_id = ${id}::uuid`;
          expect(link!.added_by).toBe("list");
          await hydrateEnvelope(id, reply);
          expect(await f.ingest(reply)).toBe(id);
          await hydrateEnvelope(id, reply);
          const [state] = await sql`SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${conversation}::uuid`;
          expect(state).toEqual({ work_status: "done", snoozed_until: snooze });
        }
        const followup = f.message("new-author@example.test", { subject: "Re: [dev] Plan", inReplyTo: root.messageId });
        expect(await f.conversation(await f.ingest(followup))).not.toBe(conversation);
      }
    } finally {
      setSystemTime();
    }
  }, 30_000);

  test("newer list-only mail does not suppress an ordinary participant reply", async () => {
    const f = await setup();
    const facts = extractMessageProtocolFacts((name) =>
      name === "list-id" ? "<dev.lists.example.test>" : name === "list-post" ? "<mailto:dev@lists.example.test>" : null,
    );
    const root = f.message("customer@example.test", { protocolFacts: facts });
    const conversation = await f.conversation(await f.ingest(root));
    await sql`UPDATE mail.conversations SET work_status = 'done', snoozed_until = '2026-11-20T12:00:00Z'
      WHERE id = ${conversation}::uuid`;
    const reply = f.message("customer@example.test", {
      protocolFacts: facts,
      inReplyTo: root.messageId,
      internalDate: new Date("2026-11-02T10:00:00Z"),
      sentAt: new Date("2026-11-02T10:00:00Z"),
    });
    const replyId = await f.ingest(reply);
    const list = f.message("bob@example.test", {
      protocolFacts: facts,
      inReplyTo: reply.messageId,
      internalDate: new Date("2026-11-03T10:00:00Z"),
      sentAt: new Date("2026-11-03T10:00:00Z"),
    });
    const listId = await f.ingest(list);
    expect(await f.conversation(listId)).toBe(conversation);
    await hydrateEnvelope(listId, list);
    const [before] = await sql`SELECT work_status FROM mail.conversations WHERE id = ${conversation}::uuid`;
    expect(before!.work_status).toBe("done");
    await hydrateEnvelope(replyId, reply);
    const [after] = await sql`SELECT work_status, snoozed_until FROM mail.conversations WHERE id = ${conversation}::uuid`;
    expect(after).toEqual({ work_status: "needs_action", snoozed_until: null });
  });

  test("stable outbound Message-ID copies require only mailbox sender identities", async () => {
    for (const kind of ["foreign", "mixed", "own", "alias", "empty"] as const) {
      const f = await setup();
      const root = f.message("support@example.test");
      root.addresses.to = [f.address("customer@example.test")];
      const id = await f.ingest(root);
      const [identity] = await sql<
        { id: string }[]
      >`SELECT id FROM mail.sender_identities WHERE mailbox_id = ${f.mailboxId}::uuid AND from_address = 'support@example.test'`;
      const actor = crypto.randomUUID();
      const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
        (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
        VALUES (${f.mailboxId}::uuid, 'Fixture', 'support@example.test', 'support@example.test', 'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'fixture') RETURNING id`;
      const [binding] = await sql<
        { id: string }[]
      >`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
        VALUES (${f.resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}') RETURNING id`;
      const [draft] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
        (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, state)
        VALUES (${newShortId()}, ${f.mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${actor}::uuid, 'user', ${actor}::uuid, 'sent') RETURNING id`;
      const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
        (mailbox_id, kind, actor_kind, actor_id, idempotency_key, request_hash, target, payload, access_subject_kind, access_subject_id, credential_scopes)
        VALUES (${f.mailboxId}::uuid, 'send', 'user', ${actor}::uuid, 'fixture', ${"f".repeat(64)}, '{}', '{}', 'user', ${actor}::uuid, ARRAY[]::text[]) RETURNING id`;
      await sql`INSERT INTO mail.outbox_submissions
        (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id, state, requested_at, mime_date, message_id)
        VALUES (${newShortId()}, ${f.mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identity!.id}::uuid,
          ${binding!.id}::uuid, ${root.messageId}, 'sent', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', ${id}::uuid)`;
      const [snapshot] = await sql<
        { subject: string; reference_ids: string[]; sent_at: Date; mime_structure: unknown; protocol_facts: unknown }[]
      >`
        SELECT subject, reference_ids, sent_at, mime_structure, protocol_facts FROM mail.message_contents WHERE id = ${id}::uuid`;
      const originalConversation = await f.conversation(id);
      const copy = f.message(kind === "alias" ? "ALIAS@EXAMPLE.TEST" : kind === "own" ? "SUPPORT@EXAMPLE.TEST" : "stranger@example.test", {
        messageId: root.messageId,
        subject: "Changed envelope",
        references: ["<changed@example.test>"],
        sentAt: new Date("2026-11-02T10:00:00Z"),
        mimeStructure: { type: "text/plain" },
        protocolFacts: extractMessageProtocolFacts((name) => (name === "list-id" ? "<list.example.test>" : null)),
      });
      if (kind === "mixed") copy.addresses.from.push(f.address("support@example.test"));
      if (kind === "empty") copy.addresses.from = [];
      const copyId = await f.ingest(copy);
      if (kind === "own" || kind === "alias") expect(copyId).toBe(id);
      else {
        expect(copyId).not.toBe(id);
        const [before] = await sql<
          { subject: string; reference_ids: string[]; sent_at: Date; mime_structure: unknown; protocol_facts: unknown }[]
        >`
          SELECT subject, reference_ids, sent_at, mime_structure, protocol_facts FROM mail.message_contents WHERE id = ${id}::uuid`;
        expect(before).toEqual(snapshot);
        expect(await f.conversation(id)).toBe(originalConversation);
        expect(await f.conversation(copyId)).not.toBe(originalConversation);
        const [foreign] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.message_addresses
          WHERE message_id = ${id}::uuid AND normalized_email = 'stranger@example.test'`;
        expect(foreign!.count).toBe(0);
      }
    }
  });
});
