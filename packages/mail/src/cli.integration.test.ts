import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { encryptSecret } from "@k2b/cloud/services";
import { sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";

/**
 * The real `cld mail` everyday commands against the real Mail API and a
 * seeded mailbox. Provider effects stay queued commands; nothing contacts a
 * mail server.
 *
 * Runs in a child process: the API module binds its middleware at import time.
 */
if (process.env.MAIL_CLI_CHILD !== "1") {
  testFor("database", "nats")(
    "cld mail lists, reads, assigns, archives, moves, and drafts replies by address",
    async () => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: { ...process.env, MAIL_CLI_CHILD: "1" },
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
  // Each scenario launches several cold CLI processes.
  setDefaultTimeout(60_000);
  const cliEntry = new URL("../../cloud-cli/src/index.ts", import.meta.url).pathname;
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxName = `CLI Support ${suffix}`;
  let home = "";
  let serverUrl = "";
  let cleanup: () => Promise<void> = async () => undefined;
  const ids = { mailbox: "", inbox: "", archive: "", projects: "", year: "", yearArchive: "", rootArchive: "", lowerArchive: "" };
  const conversations: string[] = [];
  const internal = { mailbox: "", twin: "", conversations: [] as string[] };

  const cld = async (args: string[]) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "--server", serverUrl, "--token", "cli-test", ...args],
      cwd: home,
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const cldJson = async <T>(args: string[]): Promise<T> => {
    const result = await cld(["--json", ...args]);
    if (result.exitCode !== 0) throw new Error(`cld ${args.join(" ")} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
  };

  beforeAll(async () => {
    const server = await import("@k2b/cloud/server");
    const { oauthTokens } = await import("@k2b/cloud/services");
    spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const { migrate } = await import("./migrate");
    const { newShortId } = await import("./lib/short-id");
    const { createMailbox } = await import("./service/mailboxes");
    const { default: app } = await import("./api");

    await migrate();

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-cli-${suffix}`}, 'local', 'user', 'Cli Agent', false)
      RETURNING id
    `;
    const user = {
      id: row!.id,
      uid: `mail-cli-${suffix}`,
      roles: [],
      provider: "local",
      profile: "user",
      givenname: "Cli",
      sn: "Agent",
      displayName: "Cli Agent",
      mail: "cli-agent@example.test",
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    } as User;
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    const context = {
      actor: { kind: "user" as const, user: { ...user, givenName: "Cli", memberofGroups: [] } as never },
      accessSubject: { type: "user" as const, userId: user.id },
      requestId: `mail-cli-${suffix}`,
    };

    const mailbox = await createMailbox(context, { name: mailboxName, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    internal.mailbox = mailbox.data.id;
    const twin = await createMailbox(context, { name: `${mailboxName} twin`, description: null });
    if (!twin.ok) throw new Error(twin.error.message);
    internal.twin = twin.data.id;
    const scope = "c".repeat(64);
    const [providerConnection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${internal.mailbox}::uuid, 'Fixture', 'support@example.test', 'support@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls',
        'password', ${await encryptSecret({ kind: "password", password: "cli-fixture-secret" })},
        'support@example.test', '{}'::jsonb, '{}'::jsonb, now()
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${internal.mailbox}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${providerConnection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${scope}, now()
      ) RETURNING id
    `;
    const addFolder = async (name: string, role: string, remotePath: string, parentId: string | null = null) => {
      const [folder] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status, parent_id)
        VALUES (${newShortId()}, ${resource!.id}::uuid, ${`${remotePath}-${suffix}`}, ${name}, ${role}, 'current', ${parentId}::uuid)
        RETURNING id, short_id
      `;
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (
          ${binding!.id}::uuid, ${folder!.id}::uuid, ${remotePath}, 1, 10,
          ARRAY['read', 'write_flags', 'insert', 'move', 'delete_messages']::text[], now()
        )
      `;
      return folder!;
    };
    const inbox = await addFolder("INBOX", "inbox", "INBOX");
    const archive = await addFolder("Archive", "archive", "Archive");
    const projects = await addFolder("Projekte", "other", "Projekte");
    const year = await addFolder("2025", "other", "Projekte/2025", projects.id);
    const yearArchive = await addFolder("Archiv", "other", "Projekte/2025/Archiv", year.id);
    const rootArchive = await addFolder("Archiv", "other", "Archiv");
    // Differs only in case: `Archiv` alone must not pick one of the two.
    const lowerArchive = await addFolder("archiv", "other", "archiv");
    Object.assign(ids, {
      inbox: inbox.short_id,
      archive: archive.short_id,
      projects: projects.short_id,
      year: year.short_id,
      yearArchive: yearArchive.short_id,
      rootArchive: rootArchive.short_id,
      lowerArchive: lowerArchive.short_id,
    });
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, display_name, from_address, label, is_default, status)
      VALUES (${newShortId()}, ${internal.mailbox}::uuid, 'Support', 'support@example.test', 'Support', true, 'verified')
    `;

    for (const [index, subject] of ["Invoice question", "Delivery date", "Contract renewal"].entries()) {
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date,
          size_bytes, content_hash, hydration_status, plain_text)
        VALUES (${newShortId()}, ${internal.mailbox}::uuid, ${`<cli-${index}-${suffix}@example.test>`}, ${subject},
          ${subject.toLowerCase()}, now(), 128, ${String(index).repeat(64)}, 'complete', ${`${subject} body`})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message!.id}::uuid, 'from', 0, 'Ada Customer', 'ada@customer.test', 'ada@customer.test'),
               (${message!.id}::uuid, 'to', 0, 'Support', 'support@example.test', 'support@example.test')
      `;
      const [ref] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${inbox.id}::uuid, ${message!.id}::uuid, 1, ${index + 1})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
        VALUES (${ref!.id}::uuid, ${inbox.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[], ARRAY[]::text[])
      `;
      const [conversation] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
        VALUES (${newShortId()}, ${internal.mailbox}::uuid, ${subject}, 'Ada Customer', now(), 'needs_action')
        RETURNING id, short_id
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 1, 'headers')
      `;
      conversations.push(conversation!.short_id);
      internal.conversations.push(conversation!.id);
    }

    const http = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/me") return Response.json({ id: user.id });
        if (!url.pathname.startsWith("/api/mail")) return new Response("not found", { status: 404 });
        url.pathname = url.pathname.slice("/api/mail".length) || "/";
        return app.fetch(new Request(url, request));
      },
    });
    serverUrl = `http://127.0.0.1:${http.port}`;
    home = await mkdtemp(join(tmpdir(), "cld-mail-"));
    ids.mailbox = (
      await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${internal.mailbox}::uuid`
    )[0]!.short_id;

    cleanup = async () => {
      http.stop(true);
      for (const id of [internal.mailbox, internal.twin].filter(Boolean)) {
        const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
        await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
        for (const item of access) await sql`DELETE FROM auth.access WHERE id = ${item.access_id}::uuid`;
      }
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
      await rm(home, { recursive: true, force: true });
    };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  }, 60_000);

  describe("cld mail", () => {
    test("ls resolves mailboxes by name and folders by path, and refuses to guess", async () => {
      const mailboxes = await cldJson<Array<{ id: string; name: string }>>(["mail", "ls"]);
      expect(mailboxes.map((mailbox) => mailbox.name)).toContain(mailboxName);

      const inbox = await cldJson<{ items: Array<{ id: string; subject: string }> }>(["mail", "ls", `${mailboxName}:INBOX`]);
      expect(inbox.items.map((item) => item.id).sort()).toEqual([...conversations].sort());

      const empty = await cldJson<{ items: unknown[] }>(["mail", "ls", `${mailboxName}:Projekte/2025 / Archiv`]);
      expect(empty.items).toEqual([]);

      const ambiguous = await cld(["--json", "mail", "ls", `${mailboxName}:Archiv`]);
      expect(ambiguous.exitCode).toBe(1);
      const error = JSON.parse(ambiguous.stderr) as { error: { status: number; message: string } };
      expect(error.error.status).toBe(409);
      expect(error.error.message).toBe(
        `"Archiv" matches several folders: Archiv (${ids.rootArchive}), archiv (${ids.lowerArchive}). Use one of these paths or IDs.`,
      );
      expect((await cldJson<{ items: unknown[] }>(["mail", "ls", `${mailboxName}:${ids.rootArchive}`])).items).toEqual([]);

      const missing = await cld(["--json", "mail", "ls", `${mailboxName}:Nope`]);
      expect(JSON.parse(missing.stderr).error.status).toBe(404);

      // Renaming the twin makes two mailboxes share one name: the name alone no longer resolves.
      await sql`UPDATE mail.mailboxes SET name = ${mailboxName} WHERE id = ${internal.twin}::uuid`;
      try {
        const twins = await cld(["--json", "mail", "ls", mailboxName]);
        expect(twins.exitCode).toBe(1);
        const conflict = JSON.parse(twins.stderr) as { error: { status: number; message: string } };
        expect(conflict.error.status).toBe(409);
        expect(conflict.error.message).toContain(`${mailboxName} (${ids.mailbox})`);
        expect((await cldJson<{ items: unknown[] }>(["mail", "ls", `${ids.mailbox}:INBOX`])).items).toHaveLength(3);
      } finally {
        await sql`UPDATE mail.mailboxes SET name = ${`${mailboxName} twin`} WHERE id = ${internal.twin}::uuid`;
      }
    });

    test("show, cat, assign, and a reply draft work by ID", async () => {
      await cld(["mail", "use", mailboxName]);
      const shown = await cldJson<{ conversationId: string; messages: Array<{ id: string; subject: string }> }>([
        "mail",
        "show",
        conversations[0]!,
      ]);
      expect(shown.conversationId).toBe(conversations[0]!);
      const messageId = shown.messages[0]!.id;
      const message = await cldJson<{ subject: string; plainText: string }>(["mail", "cat", messageId]);
      expect(message).toMatchObject({ subject: "Invoice question", plainText: "Invoice question body" });

      const assigned = await cldJson<{ results: Array<{ conversationId: string; status: string }> }>([
        "mail",
        "assign",
        conversations[0]!,
        conversations[1]!,
        "--to",
        "me",
      ]);
      expect(assigned.results).toEqual([
        { conversationId: conversations[0]!, status: "ok" },
        { conversationId: conversations[1]!, status: "ok" },
      ]);
      const mine = await cldJson<{ items: Array<{ id: string }> }>(["mail", "ls", ids.mailbox, "--view", "mine"]);
      expect(mine.items.map((item) => item.id).sort()).toEqual([conversations[0]!, conversations[1]!].sort());

      const draft = await cldJson<{ id: string; intent: string; subject: string; to: Array<{ address: string }> }>([
        "mail",
        "reply",
        conversations[0]!,
        "--body",
        "Thanks, we are on it.",
      ]);
      expect(draft).toMatchObject({ intent: "reply", subject: "Re: Invoice question", to: [{ address: "ada@customer.test" }] });
    });

    test("archive and mv queue one provider move per conversation from the Inbox", async () => {
      const archived = await cldJson<{ results: Array<{ conversationId: string; status: string; commands: Array<{ kind: string }> }> }>([
        "mail",
        "archive",
        conversations[0]!,
      ]);
      expect(archived.results).toMatchObject([{ conversationId: conversations[0]!, status: "ok", commands: [{ kind: "move" }] }]);

      const moved = await cldJson<{ results: Array<{ conversationId: string; status: string }> }>([
        "mail",
        "mv",
        conversations[1]!,
        conversations[2]!,
        "--to",
        `${mailboxName}:Projekte / 2025`,
      ]);
      expect(moved.results.map((result) => result.status)).toEqual(["ok", "ok"]);
      const moves = await sql<{ source: string; destination: string }[]>`
        SELECT source.short_id AS source, destination.short_id AS destination
        FROM mail.commands command
        JOIN mail.folders source ON source.id = (command.target ->> 'sourceFolderId')::uuid
        JOIN mail.folders destination ON destination.id = (command.target ->> 'destinationFolderId')::uuid
        WHERE command.mailbox_id = ${internal.mailbox}::uuid AND command.kind = 'move'
      `;
      expect(moves.map((move) => `${move.source} -> ${move.destination}`).sort()).toEqual(
        [`${ids.inbox} -> ${ids.archive}`, `${ids.inbox} -> ${ids.year}`, `${ids.inbox} -> ${ids.year}`].sort(),
      );
    });
  });
}
