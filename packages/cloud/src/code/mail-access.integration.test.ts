import { afterAll, beforeAll, expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "../../../mail/src/service/auth";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { accounts } from "../services/accounts";
import { serviceAccounts } from "../services/service-accounts";
import { codeAccessBindings, listCodeAccess, removeCodeAccess, setCodeAccess } from "./access";
import type { CodeAccessProofClaims } from "./access-proof";

// Select the final private database and Sync namespace before loading Mail domain modules.
await import("../../../mail/test/integration-preload");
const { mailCapabilities } = await import("../../../mail/src/capabilities");
const { getMailboxPermission } = await import("../../../mail/src/service/access");
const { createMailbox } = await import("../../../mail/src/service/mailboxes");

const suite = suiteFor("database", "nats");

suite("Mail adapter through platform Code access", () => {
  let owner: User;
  let mailboxId: string;
  let target: { type: string; id: string };
  let principal: string;
  let code: MailRequestContext;
  const grantId = crypto.randomUUID();
  const bindings = codeAccessBindings("mail", mailCapabilities);
  const context = (operation: "set" | "list" | "rm"): CapabilityExecutionContext => {
    const actor = {
      kind: "user" as const,
      user: owner,
      delegation: {
        kind: "invocation" as const,
        callingAppId: "core",
        credentialKind: "session" as const,
        invocationId: "mail-code-access-conformance",
        codeAccess: operation,
      },
    };
    const accessSubject = { type: "user" as const, userId: owner.id };
    return {
      actor,
      accessSubject,
      user: owner,
      authority: { actor, accessSubject, credentialKind: "invocation", scopes: [] },
      locale: "en",
      requestId: "mail-code-access-conformance",
      origin: "app",
      signal: new AbortController().signal,
    };
  };

  beforeAll(async () => {
    await migrateCloudCapabilities();
    const suffix = crypto.randomUUID();
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`c3c-platform-${suffix}`}, 'local', 'user', 'Mailbox owner') RETURNING id`;
    if (!person) throw new Error("Missing person");
    const current = await accounts.users.get({ id: person.id });
    if (!current) throw new Error("Missing person");
    owner = current;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`c3c-platform-${suffix}`}, 'code') RETURNING id`;
    if (!account) throw new Error("Missing Code account");
    principal = account.id;
    const serviceAccount = await serviceAccounts.get({ id: principal });
    if (!serviceAccount) throw new Error("Missing Code account");
    code = {
      actor: { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["read", "write"] },
      accessSubject: { type: "service_account", serviceAccountId: principal },
    };
    const mailbox = await createMailbox(context("set"), { name: "Code platform fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (!row) throw new Error("Missing mailbox public ID");
    target = { type: "mail.mailbox", id: row.short_id };
  });

  afterAll(async () => {
    await sql`DELETE FROM capabilities.code_access_grants WHERE app_id = 'mail' AND grant_id = ${grantId}::uuid`;
    if (mailboxId) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const row of rows) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    if (principal) await sql`DELETE FROM auth.service_accounts WHERE id = ${principal}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("set, retry and list keep the public target ID; removal takes effect and proof replay cannot restore it", async () => {
    const operations = ["mail.mailbox.read", "mail.search"];
    const claims: CodeAccessProofClaims = {
      ver: 1,
      iss: "https://cloud.example",
      aud: "app:mail",
      token_use: "code_access",
      iat: 1,
      nbf: 1,
      exp: 31,
      codeId: "code-mail-fixture",
      versionId: "version-mail-fixture",
      activationId: crypto.randomUUID(),
      activatingPerson: owner.id,
      principal,
      grantId,
      target,
      operations,
    };
    // Signature/binding verification has its own tests; this test checks the real app and platform storage seam.
    const dependencies = { db: sql, verifyProof: async () => claims };
    const input = { proof: "verified-proof-fixture", target, operations };
    expect(await setCodeAccess("mail", bindings, { ...input, dryRun: true }, context("set"), dependencies)).toEqual({
      granted: true,
      grantId,
      level: "read",
    });
    expect(await getMailboxPermission(code, mailboxId)).toBe("none");
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await setCodeAccess("mail", bindings, input, context("set"), dependencies)).toEqual({ granted: true, grantId, level: "read" });
    expect(await getMailboxPermission(code, mailboxId)).toBe("read");
    expect(await listCodeAccess("mail", bindings, principal, context("list"))).toEqual([{ grantId, principal, target, level: "read" }]);
    expect(await removeCodeAccess("mail", bindings, grantId, { context: context("rm") })).toBe(true);
    expect(await getMailboxPermission(code, mailboxId)).toBe("none");
    expect(await listCodeAccess("mail", bindings, principal, context("list"))).toEqual([]);
    expect(await setCodeAccess("mail", bindings, input, context("set"), dependencies)).toMatchObject({
      granted: false,
      reasonCode: "removed",
    });
  });
});
