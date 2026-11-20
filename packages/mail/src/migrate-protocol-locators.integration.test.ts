import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { buildDraftRemoteIdIndex, buildRemoteMessageIdIndex, migrate } from "./migrate";

const suite = suiteFor("database", "nats");
const folder = "00000000-0000-4000-8000-000000000201";
const otherFolder = "00000000-0000-4000-8000-000000000202";
const message = "00000000-0000-4000-8000-000000000203";

suite("mail protocol locator schema", () => {
  test("schema: checks all nullable address shapes and keeps UID value checks", async () => {
    await migrate();
    await sql.begin(async (tx) => {
      // LIKE copies the actual CHECKs and indexes; no foreign domain fixture is needed.
      await tx`CREATE TEMP TABLE locator_refs (LIKE mail.remote_message_refs INCLUDING ALL) ON COMMIT DROP`.simple();
      await tx`CREATE TEMP TABLE locator_snapshots (LIKE mail.draft_provider_snapshots INCLUDING ALL) ON COMMIT DROP`.simple();
      for (const uidValidity of [null, "10"])
        for (const uid of [null, "42"])
          for (const remoteId of [null, "email_alpha"]) {
            const addressed =
              (remoteId === null && uidValidity !== null && uid !== null) || (remoteId !== null && uidValidity === null && uid === null);
            const absent = remoteId === null && uidValidity === null && uid === null;
            const stage = `schema (${uidValidity}, ${uid}, ${remoteId})`;
            const insertRef = () =>
              tx.savepoint(async (sp) => {
                await sp`INSERT INTO locator_refs (folder_id, message_id, uid_validity, uid, remote_id)
            VALUES (${folder}::uuid, ${message}::uuid, ${uidValidity}::numeric, ${uid}::numeric, ${remoteId})`;
                await sp`DELETE FROM locator_refs`;
              });
            if (addressed) await expect(insertRef(), stage).resolves.toBeUndefined();
            else await expect(insertRef(), stage).rejects.toMatchObject({ constraint: "remote_message_refs_address_shape" });
            for (const folderId of [null, folder]) {
              const insertSnapshot = () =>
                tx.savepoint(async (sp) => {
                  await sp`INSERT INTO locator_snapshots (mailbox_id, direction, stable_message_id, folder_id, uid_validity, uid, remote_id)
              VALUES (${message}::uuid, 'import', '<shape@example.test>', ${folderId}::uuid, ${uidValidity}::numeric, ${uid}::numeric, ${remoteId})`;
                  await sp`DELETE FROM locator_snapshots`;
                });
              if (absent || (addressed && folderId)) await expect(insertSnapshot(), `${stage} folder=${folderId}`).resolves.toBeUndefined();
              else
                await expect(insertSnapshot(), `${stage} folder=${folderId}`).rejects.toMatchObject({
                  constraint: "draft_provider_snapshots_address_shape",
                });
            }
          }
      for (const [uidValidity, uid] of [
        ["-1", "42"],
        ["10", "0"],
      ]) {
        await expect(
          tx.savepoint(async (sp) => {
            await sp`INSERT INTO locator_refs (folder_id, message_id, uid_validity, uid)
            VALUES (${folder}::uuid, ${message}::uuid, ${uidValidity}::numeric, ${uid}::numeric)`;
          }),
          "schema: IMAP value checks",
        ).rejects.toThrow();
      }
      await tx`INSERT INTO locator_refs (folder_id, message_id, uid_validity, uid) VALUES (${folder}::uuid, ${message}::uuid, 10, 42)`;
      await expect(
        tx.savepoint(async (sp) => {
          await sp`UPDATE locator_refs SET remote_id = 'email_alpha'`;
        }),
        "schema: mixed UPDATE",
      ).rejects.toMatchObject({ constraint: "remote_message_refs_address_shape" });
      // NOT VALID still protects every new write; only the pre-existing-row scan is deferred.
      await tx`ALTER TABLE locator_refs DROP CONSTRAINT remote_message_refs_address_shape`.simple();
      await tx`ALTER TABLE locator_refs ADD CONSTRAINT remote_message_refs_address_shape CHECK (
        (remote_id IS NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL)
        OR (remote_id IS NOT NULL AND uid_validity IS NULL AND uid IS NULL)) NOT VALID`.simple();
      await expect(
        tx.savepoint(async (sp) => {
          await sp`UPDATE locator_refs SET uid = NULL`;
        }),
        "schema: NOT VALID rejects new invalid writes",
      ).rejects.toMatchObject({ constraint: "remote_message_refs_address_shape" });
    });
  });

  test("indexes: ref identity includes stale rows and folder, snapshot history remains nonunique", async () => {
    await migrate();
    expect(["built", "ready"], "indexes: ref ready").toContain(await buildRemoteMessageIdIndex());
    expect(["built", "ready"], "indexes: snapshot ready").toContain(await buildDraftRemoteIdIndex());
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE unique_locator_refs (LIKE mail.remote_message_refs INCLUDING ALL) ON COMMIT DROP`.simple();
      await tx`CREATE TEMP TABLE history_locator_snapshots (LIKE mail.draft_provider_snapshots INCLUDING ALL) ON COMMIT DROP`.simple();
      await tx`INSERT INTO unique_locator_refs (folder_id, message_id, remote_id, stale_at)
        VALUES (${folder}::uuid, ${message}::uuid, 'email_alpha', '2026-11-19T12:00:00Z')`;
      await expect(
        tx.savepoint(async (sp) => {
          await sp`INSERT INTO unique_locator_refs (folder_id, message_id, remote_id) VALUES (${folder}::uuid, ${message}::uuid, 'email_alpha')`;
        }),
        "indexes: stale JMAP duplicate",
      ).rejects.toThrow();
      await tx`INSERT INTO unique_locator_refs (folder_id, message_id, remote_id) VALUES (${otherFolder}::uuid, ${message}::uuid, 'email_alpha')`;
      await tx`INSERT INTO unique_locator_refs (folder_id, message_id, uid_validity, uid) VALUES (${folder}::uuid, ${message}::uuid, 10, 42)`;
      await expect(
        tx.savepoint(async (sp) => {
          await sp`INSERT INTO unique_locator_refs (folder_id, message_id, uid_validity, uid) VALUES (${folder}::uuid, ${message}::uuid, 10, 42)`;
        }),
        "indexes: IMAP duplicate",
      ).rejects.toThrow();
      await tx`INSERT INTO history_locator_snapshots (mailbox_id, direction, stable_message_id, folder_id, remote_id)
        SELECT ${message}::uuid, 'import', '<history@example.test>', ${folder}::uuid, 'email_alpha' FROM generate_series(1, 2)`;
      expect(
        await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM history_locator_snapshots`,
        "indexes: two historical observations",
      ).toEqual([{ count: 2 }]);
    });
  });

  test("upgrade: old IMAP rows and heaps survive two migrations and predecessor reads/writes", async () => {
    await migrate();
    const [mailbox] = await sql<
      { id: string }[]
    >`INSERT INTO mail.mailboxes (short_id, name) VALUES ('LocMB1', 'Locator upgrade') RETURNING id`;
    if (!mailbox) throw new Error("upgrade: mailbox fixture missing");
    try {
      const [resource] = await sql<
        { id: string }[]
      >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint)
        VALUES (${mailbox.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}) RETURNING id`;
      if (!resource) throw new Error("upgrade: resource fixture missing");
      await sql`INSERT INTO mail.folders (id, short_id, remote_resource_id, stable_key, name) VALUES (${folder}::uuid, 'LocFD1', ${resource.id}::uuid, 'upgrade', 'Inbox')`;
      await sql`INSERT INTO mail.message_contents (id, short_id, mailbox_id, content_hash, internal_date)
        VALUES (${message}::uuid, 'LocMS1', ${mailbox.id}::uuid, ${"b".repeat(64)}, '2026-11-19T12:00:00Z')`;
      const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folder}::uuid, ${message}::uuid, 10, 42) RETURNING id`;
      if (!ref) throw new Error("upgrade: ref fixture missing");
      await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id) VALUES (${ref.id}::uuid, ${folder}::uuid, ${message}::uuid)`;
      await sql`INSERT INTO mail.draft_provider_snapshots (mailbox_id, direction, stable_message_id, folder_id, uid_validity, uid)
        VALUES (${mailbox.id}::uuid, 'import', '<upgrade@example.test>', ${folder}::uuid, 10, 43)`;
      const evidence = async () => ({
        refs: await sql`SELECT id, folder_id, message_id, uid_validity::text, uid::text FROM mail.remote_message_refs WHERE message_id = ${message}::uuid`,
        contents: await sql`SELECT id, content_hash FROM mail.message_contents WHERE id = ${message}::uuid`,
        placements: await sql`SELECT * FROM mail.message_placements WHERE message_id = ${message}::uuid`,
        snapshots:
          await sql`SELECT id, folder_id, uid_validity::text, uid::text FROM mail.draft_provider_snapshots WHERE mailbox_id = ${mailbox.id}::uuid`,
        heaps:
          await sql`SELECT relname, relfilenode FROM pg_class WHERE oid IN ('mail.remote_message_refs'::regclass, 'mail.draft_provider_snapshots'::regclass) ORDER BY relname`,
        markers: await sql`SELECT version, name, applied_at FROM mail.schema_migrations ORDER BY version`,
      });
      await sql`ALTER TABLE mail.remote_message_refs DROP COLUMN remote_id`.simple();
      await sql`ALTER TABLE mail.remote_message_refs ALTER COLUMN uid_validity SET NOT NULL, ALTER COLUMN uid SET NOT NULL`.simple();
      await sql`ALTER TABLE mail.draft_provider_snapshots DROP COLUMN remote_id`.simple();
      await sql`ALTER TABLE mail.draft_provider_snapshots ADD CONSTRAINT draft_provider_snapshots_remote_shape
        CHECK ((uid_validity IS NULL AND uid IS NULL) OR (folder_id IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL))`.simple();
      const before = await evidence();
      for (let run = 1; run <= 2; run++) {
        await migrate();
        expect(await evidence(), `upgrade: preserved after run ${run}`).toEqual(before);
        expect(
          await sql<{ conname: string; convalidated: boolean }[]>`SELECT conname, convalidated FROM pg_constraint WHERE conname IN
          ('remote_message_refs_address_shape', 'draft_provider_snapshots_address_shape') ORDER BY conname`,
          `upgrade: validated run ${run}`,
        ).toEqual([
          { conname: "draft_provider_snapshots_address_shape", convalidated: true },
          { conname: "remote_message_refs_address_shape", convalidated: true },
        ]);
      }
      expect(await buildRemoteMessageIdIndex(), "upgrade: concurrent ref build").toBe("built");
      expect(await buildDraftRemoteIdIndex(), "upgrade: concurrent snapshot build").toBe("built");
      expect(await buildRemoteMessageIdIndex(), "upgrade: reuse valid ref index").toBe("ready");
      expect(await buildDraftRemoteIdIndex(), "upgrade: reuse valid snapshot index").toBe("ready");
      // Frozen immediate predecessor: its markers plus this branch's rule retirement, and IMAP-only INSERT/SELECT.
      await sql.begin(async (tx) => {
        const markers = await tx<{ version: number; name: string }[]>`SELECT version, name FROM mail.schema_migrations ORDER BY version`;
        expect(markers, "rollback: predecessor markers").toEqual([
          { version: 1, name: "baseline" },
          { version: 2, name: "principal_assignees" },
          { version: 3, name: "suggestions_per_author" },
          { version: 4, name: "one_reply_draft" },
          { version: 5, name: "rules_retired" },
        ]);
        await tx`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid) VALUES (${folder}::uuid, ${message}::uuid, 10, 44)`;
        expect(
          await tx<
            { uid: string }[]
          >`SELECT uid::text FROM mail.remote_message_refs WHERE folder_id = ${folder}::uuid AND uid_validity = 10 ORDER BY uid`,
          "rollback: predecessor read",
        ).toEqual([{ uid: "42" }, { uid: "44" }]);
      });
    } finally {
      await migrate();
      await sql`DELETE FROM mail.draft_provider_snapshots WHERE mailbox_id = ${mailbox.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
    }
  });
});
