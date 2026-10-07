import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Principal } from "@k2b/cloud/contracts";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { grantMailboxAccess, listMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { getMailboxDetails } from "./mailbox-details";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

/** Everyone who can read a mailbox sees who has access and how it is connected; nobody else does. */
suite("mail mailbox details", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const groupIds: string[] = [];
  let mailboxId = "";
  let owner: MailRequestContext;
  let reader: MailRequestContext;
  let guest: MailRequestContext;
  let outsider: MailRequestContext;
  let readerId = "";

  const createUser = async (label: string, displayName: string, profile: "user" | "guest" = "user") => {
    const uid = `mail-details-${label}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', ${profile}, ${displayName}, false)
      RETURNING id
    `;
    userIds.push(row!.id);
    const context: MailRequestContext = {
      actor: {
        kind: "user",
        user: {
          id: row!.id,
          uid,
          provider: "local",
          profile,
          displayName,
          givenName: "Mail",
          sn: "Details",
          mail: `${uid}@example.test`,
          roles: profile === "user" ? ["user"] : ["guest", "local/guest"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: row!.id },
      requestId: `mail-details-${suffix}`,
    };
    return { id: row!.id, context };
  };

  const createGroup = async (name: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name) VALUES (${name}, 'local', ${name}) RETURNING id`;
    groupIds.push(row!.id);
    return row!.id;
  };

  const grant = async (principal: Principal, permission: "read" | "write") => {
    const granted = await grantMailboxAccess({ context: owner, mailboxId, principal, permission });
    if (!granted.ok) throw new Error(granted.error.message);
  };

  const addConnection = async (email: string, status: "active" | "revoked") => {
    await sql`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, status, last_verified_at
      ) VALUES (
        ${mailboxId}::uuid, 'Fixture', ${email}, ${`login-${suffix}`}, 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 587, 'starttls', 'password',
        ${status === "revoked" ? null : await encryptSecret({ kind: "password", password: "details-fixture-secret" })},
        ${email}, '{}'::jsonb, '{}'::jsonb, ${status}, '2026-10-07T08:00:00.000Z'
      )
    `;
  };

  beforeAll(async () => {
    await migrate();
    owner = (await createUser("owner", `Owner ${suffix}`)).context;
    const readerUser = await createUser("reader", `Reader ${suffix}`);
    reader = readerUser.context;
    readerId = readerUser.id;
    outsider = (await createUser("outsider", `Outsider ${suffix}`)).context;
    const guestUser = await createUser("guest", `Guest ${suffix}`, "guest");
    guest = guestUser.context;
    const guestTeam = await createGroup(`mail-details-guests-${suffix}`);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${guestUser.id}::uuid, ${guestTeam}::uuid)`;
    const staff = await createGroup(`mail-details-staff-${suffix}`);

    const mailbox = await createMailbox(owner, { name: `Details ${suffix}`, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    await grant({ type: "user", userId: readerId }, "read");
    await grant({ type: "group", groupId: staff }, "write");
    // The guest reads directly and through a group they belong to.
    await grant({ type: "group", groupId: guestTeam }, "read");
    await grant({ type: "user", userId: guestUser.id }, "read");
    await addConnection("old@example.test", "revoked");
    await addConnection("support@example.test", "active");
    await sql`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status, last_sync_at)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active',
        '2026-10-07T09:30:00.000Z')
    `;
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
      }
    }
    if (groupIds.length > 0) {
      await sql`DELETE FROM auth.groups WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${groupIds}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("a full account that reads sees every grant, the connected account, and the last sync", async () => {
    const details = await getMailboxDetails(reader, mailboxId);
    if (!details.ok) throw new Error(details.error.message);

    expect(details.data.permission).toBe("read");
    // Managers first, each with the name the permission editor shows.
    expect(details.data.access.map((entry) => [entry.displayName, entry.permission])).toEqual([
      [`Owner ${suffix}`, "admin"],
      [`mail-details-staff-${suffix}`, "write"],
      [`Reader ${suffix}`, "read"],
      [`mail-details-guests-${suffix}`, "read"],
      [`Guest ${suffix}`, "read"],
    ]);
    expect(details.data.hiddenAccessCount).toBe(0);
    // A revoked connection is history, not the mailbox's account; the login name and credentials stay with administrators.
    expect(details.data.account).toEqual({ email: "support@example.test", server: "imap.example.test" });
    expect(details.data.lastSyncAt).toBe("2026-10-07T09:30:00.000Z");

    // Reading the grants does not make them manageable: the management list stays with administrators.
    const managed = await listMailboxAccess(reader, mailboxId);
    expect(managed.ok).toBe(false);
  });

  test("a guest sees only the grants the directory shows them: their own and their groups'", async () => {
    const details = await getMailboxDetails(guest, mailboxId);
    if (!details.ok) throw new Error(details.error.message);
    expect(details.data.permission).toBe("read");
    expect(details.data.access.map((entry) => entry.displayName)).toEqual([`mail-details-guests-${suffix}`, `Guest ${suffix}`]);
    expect(details.data.hiddenAccessCount).toBe(3);
  });

  test("someone without access learns nothing about the mailbox", async () => {
    const details = await getMailboxDetails(outsider, mailboxId);
    expect(details.ok).toBe(false);
    if (!details.ok) expect(details.error.code).toBe("FORBIDDEN");
  });
});
