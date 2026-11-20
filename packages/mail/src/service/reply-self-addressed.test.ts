import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { ok } from "@k2b/stdlib";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import * as access from "./access";
import type { MailRequestContext } from "./auth";
import { prepareDraftSeed } from "./drafts";

const mailboxId = "11111111-1111-4111-8111-111111111111";
const sourceMessageId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const senderIdentityId = "44444444-4444-4444-8444-444444444444";
const context: MailRequestContext = {
  actor: {
    kind: "user",
    user: {
      id: "55555555-5555-4555-8555-555555555555",
      uid: "test-user",
      provider: "local",
      profile: "user",
      givenname: "Test",
      sn: "User",
      displayName: "Test User",
      mail: "info@example.test",
      roles: ["user"],
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    },
  },
  accessSubject: { type: "user", userId: "55555555-5555-4555-8555-555555555555" },
};

useUnitClients();

describe("self-addressed reply seed service", () => {
  afterEach(() => setSystemTime());
  for (const intent of ["reply", "reply_all"] as const) {
    test(`${intent} prepares an editable seed with no recipient`, async () => {
      setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
      // Only storage and access are doubled; execute the public service and its real recipient derivation.
      const transaction = Object.assign(
        new Proxy(sql, {
          apply(_target, _this, args) {
            const query = String.raw({ raw: args[0] }, ...args.slice(1));
            if (query.includes("FROM mail.mailboxes")) return [{ id: mailboxId }];
            if (query.includes("default_cc"))
              return [
                {
                  // The sender was already required to be verified; validation now reads that status from the row.
                  from_address: "info@example.test",
                  status: "verified",
                  default_cc: [],
                  default_bcc: [],
                  default_format: "plain",
                  default_priority: "normal",
                  default_delivery_receipt: false,
                  default_read_receipt: false,
                },
              ];
            if (query.includes("FROM mail.conversation_messages")) return [{ message_id: sourceMessageId }];
            if (query.includes("SELECT subject FROM mail.message_contents")) return [{ subject: "Note to self" }];
            if (query.includes("FROM mail.message_addresses"))
              return ["from", "to", "cc"].map((role) => ({ role, display_name: null, email: "info@example.test" }));
            if (query.includes("FROM mail.sender_identities")) return [{ from_address: "info@example.test", reply_to: null }];
            if (query.includes("FROM mail.conversation_references")) return [];
            throw new Error(`Unexpected storage query: ${query}`);
          },
        }),
        {
          savepoint: () => {
            throw new Error("Unexpected savepoint");
          },
        },
      );
      const begin = spyOn(sql, "begin").mockImplementation(async (callbackOrOptions, optionalCallback?) => {
        const callback = typeof callbackOrOptions === "function" ? callbackOrOptions : optionalCallback;
        if (typeof callback !== "function") throw new Error("Unexpected transaction options");
        return callback(transaction);
      });
      const allowed = spyOn(access, "requireMailboxAccess").mockResolvedValue(ok({ scope: "mailbox", permission: "write" }));
      try {
        const result = await prepareDraftSeed({
          context,
          mailboxId,
          origin: {
            kind: "compose",
            input: {
              senderIdentityId,
              signatureTemplateId: null,
              quoteSource: null,
              conversationId,
              sourceMessageId,
              intent,
              to: [],
              cc: [],
              bcc: [],
              subject: "",
              body: "",
              includeSourceAttachments: false,
            },
          },
        });
        expect(result).toMatchObject({
          ok: true,
          data: { intent, sourceMessageId, content: { to: [], cc: [], bcc: [], subject: "Re: Note to self" } },
        });
      } finally {
        begin.mockRestore();
        allowed.mockRestore();
      }
    });
  }
});
