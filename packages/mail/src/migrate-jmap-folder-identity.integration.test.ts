import { expect, test } from "bun:test";
import { lazySync, sql } from "@k2b/cloud";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { buildFolderIdentityIndexes, migrate } from "./migrate";
import baseline from "./schema.sql" with { type: "text" };
import { projectJmapFolders } from "./service/bindings";
import { sha256Json } from "./service/canonical";
import type { JmapRemoteFolder } from "./service/connectors/jmap";
import { jmapFolderStableKey, jmapScopeFingerprint, type JmapScopeEvidence } from "./service/provider-identity";

const suite = suiteFor("database", "nats");
const mailboxId = "00000000-0000-4000-8000-000000000301";
const resourceId = "00000000-0000-4000-8000-000000000302";
const connectionId = "00000000-0000-4000-8000-000000000303";
const bindingId = "00000000-0000-4000-8000-000000000304";
const folderId = "00000000-0000-4000-8000-000000000305";
const otherFolderId = "00000000-0000-4000-8000-000000000306";
const thirdFolderId = "00000000-0000-4000-8000-000000000308";
const fourthFolderId = "00000000-0000-4000-8000-000000000309";
const messageId = "00000000-0000-4000-8000-000000000307";
const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: "https://mail.example.invalid", accountId: "account_1" };
const indexMutex = lazySync((sync) => sync.mutex({ id: "mail:index-build", ttlMs: 60_000, retry: { maxAttempts: 1 } }));
const folder = (mailboxId: string, name = "Same", parentMailboxId: string | null = null): JmapRemoteFolder => ({
  mailboxId, parentMailboxId, name, path: name, parentPath: null, delimiter: "/", role: "other", subscribed: true,
  selectable: true, stableKey: jmapFolderStableKey(evidence, mailboxId), rights: ["read", "insert"], rightsSource: "acl",
  uidValidity: null, uidNext: null, highestModseq: null,
});
const project = (folders: JmapRemoteFolder[], inventory: Parameters<typeof projectJmapFolders>[1]["inventory"] = { kind: "snapshot" }) =>
  sql.begin((tx) => projectJmapFolders(tx, { remoteResourceId: resourceId, bindingId, discoveryGeneration: 1, evidence, folders, inventory }));

async function seed(kind: "imap_smtp" | "jmap") {
  const storedEvidence = kind === "jmap" ? evidence : {
    version: 2, serverKey: "a".repeat(64), accountId: "account_1", namespaces: [], folders: [],
  };
  const fingerprint = kind === "jmap" ? jmapScopeFingerprint(evidence) : sha256Json(storedEvidence);
  await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailboxId}::uuid, 'JmpMB1', 'Folder identity fixture')`;
  await sql`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint)
    VALUES (${resourceId}::uuid, ${mailboxId}::uuid, ${kind}, '{}'::jsonb, '{}'::jsonb, ${fingerprint})`;
  await sql`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
    imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
    VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'reader@example.invalid', 'reader', ${kind},
      'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password', 'fictional-unused')`;
  await sql`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator,
    verification_evidence, verified_scope_fingerprint)
    VALUES (${bindingId}::uuid, ${resourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId: storedEvidence.accountId }}::jsonb, ${storedEvidence}::jsonb, ${fingerprint})`;
}
const legacyRule = async () => {
  const [row] = await sql<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mail.binding_folder_refs'::regclass AND conname = 'binding_folder_refs_binding_id_remote_path_key') AS present`;
  return row?.present;
};

suite("JMAP folder identity", () => {
  test("baseline: protocol-specific uniqueness and connector checks", async () => {
    await migrate();
    await sql.begin(async (tx) => {
      // Execute the actual baseline table and indexes in a temporary table, independently of upgrade state.
      const table = baseline.match(/CREATE TABLE mail\.binding_folder_refs \([\s\S]*?\n\);/)?.[0];
      if (!table) throw new Error("baseline: folder refs definition missing");
      await tx.unsafe(table.replace("CREATE TABLE mail.binding_folder_refs", "CREATE TEMP TABLE baseline_folder_refs")).simple();
      for (const constraint of baseline.matchAll(/ALTER TABLE ONLY mail\.binding_folder_refs\n    ADD CONSTRAINT [^;]+(?:UNIQUE|PRIMARY KEY)[^;]+;/g)) {
        await tx.unsafe(constraint[0].replace("mail.binding_folder_refs", "baseline_folder_refs")).simple();
      }
      for (const name of ["imap_path", "jmap_id"]) {
        const index = baseline.match(new RegExp(`CREATE UNIQUE INDEX binding_folder_refs_${name}_idx [^;]+;`))?.[0];
        if (!index) throw new Error(`baseline: ${name} index missing`);
        await tx.unsafe(index.replace("mail.binding_folder_refs", "baseline_folder_refs")).simple();
      }
      await tx`INSERT INTO baseline_folder_refs (binding_id, folder_id, remote_path)
        VALUES (${bindingId}::uuid, ${folderId}::uuid, 'Same')`;
      await expect(tx.savepoint(async (sp) => {
        await sp`INSERT INTO baseline_folder_refs (binding_id, folder_id, remote_path)
          VALUES (${bindingId}::uuid, ${otherFolderId}::uuid, 'Same')`;
      }), "baseline: duplicate IMAP path").rejects.toMatchObject({ constraint: "binding_folder_refs_imap_path_idx" });
      await tx`INSERT INTO baseline_folder_refs (binding_id, folder_id, remote_path, remote_folder_id)
        VALUES (${bindingId}::uuid, ${otherFolderId}::uuid, 'Same', 'alpha'), (${bindingId}::uuid, ${thirdFolderId}::uuid, 'Same', 'beta')`;
      await expect(tx.savepoint(async (sp) => {
        await sp`INSERT INTO baseline_folder_refs (binding_id, folder_id, remote_path, remote_folder_id)
          VALUES (${bindingId}::uuid, ${fourthFolderId}::uuid, 'Different', 'alpha')`;
      }), "baseline: duplicate mailbox ID").rejects.toMatchObject({ constraint: "binding_folder_refs_jmap_id_idx" });
      await expect(tx.savepoint(async (sp) => {
        await sp`INSERT INTO baseline_folder_refs (binding_id, folder_id, remote_path, remote_folder_id)
          VALUES (${bindingId}::uuid, ${folderId}::uuid, 'Different', 'gamma')`;
      }), "baseline: binding/folder conflict target retained").rejects.toMatchObject({ constraint: "binding_folder_refs_binding_id_folder_id_key" });
      await tx`DROP TABLE baseline_folder_refs`.simple();
      await tx`CREATE TEMP TABLE kind_connections (LIKE mail.provider_connections INCLUDING ALL) ON COMMIT DROP`.simple();
      await tx`CREATE TEMP TABLE kind_resources (LIKE mail.remote_resources INCLUDING ALL) ON COMMIT DROP`.simple();
      for (const kind of ["imap_smtp", "jmap", "unknown"]) {
        const insert = () => tx.savepoint(async (sp) => {
          await sp`INSERT INTO kind_connections (owner_mailbox_id, name, email, username, connector_kind,
            imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
            VALUES (${mailboxId}::uuid, 'Fixture', 'reader@example.invalid', 'reader', ${kind},
              'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password', 'fictional-unused')`;
          await sp`DELETE FROM kind_connections`;
        });
        const insertResource = () => tx.savepoint(async (sp) => {
          await sp`INSERT INTO kind_resources (mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint)
            VALUES (${mailboxId}::uuid, ${kind}, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)})`;
          await sp`DELETE FROM kind_resources`;
        });
        if (kind === "unknown") {
          await expect(insert(), "baseline: unknown connection kind").rejects.toMatchObject({ constraint: "provider_connections_connector_kind_check" });
          await expect(insertResource(), "baseline: unknown resource kind").rejects.toMatchObject({ constraint: "remote_resources_connector_kind_check" });
        } else {
          await expect(insert(), `baseline: connection ${kind}`).resolves.toBeUndefined();
          await expect(insertResource(), `baseline: resource ${kind}`).resolves.toBeUndefined();
        }
      }
    });
  });

  test("upgrade: two starts preserve IMAP; busy and invalid indexes keep the path rule", async () => {
    await migrate();
    await seed("imap_smtp");
    try {
      await sql`INSERT INTO mail.folders (id, short_id, remote_resource_id, stable_key, name)
        VALUES (${folderId}::uuid, 'JmpFD1', ${resourceId}::uuid, 'first', 'First'),
          (${otherFolderId}::uuid, 'JmpFD2', ${resourceId}::uuid, 'second', 'Second')`;
      await sql`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq)
        VALUES (${bindingId}::uuid, ${folderId}::uuid, 'First', 10, 20, 30), (${bindingId}::uuid, ${otherFolderId}::uuid, 'Second', 11, 21, 31)`;
      await sql`ALTER TABLE mail.binding_folder_refs DROP COLUMN remote_folder_id`.simple();
      if (!(await legacyRule())) await sql`ALTER TABLE mail.binding_folder_refs
        ADD CONSTRAINT binding_folder_refs_binding_id_remote_path_key UNIQUE (binding_id, remote_path)`.simple();
      await sql`ALTER TABLE mail.provider_connections DROP CONSTRAINT provider_connections_connector_kind_check,
        ADD CONSTRAINT provider_connections_connector_kind_check CHECK (connector_kind = 'imap_smtp')`.simple();
      await sql`ALTER TABLE mail.remote_resources DROP CONSTRAINT remote_resources_connector_kind_check,
        ADD CONSTRAINT remote_resources_connector_kind_check CHECK (connector_kind = 'imap_smtp')`.simple();
      const preserved = async () => ({
        refs: await sql`SELECT id, binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, updated_at
          FROM mail.binding_folder_refs WHERE binding_id = ${bindingId}::uuid ORDER BY folder_id`,
        heaps: await sql`SELECT relname, relfilenode FROM pg_class WHERE oid IN ('mail.binding_folder_refs'::regclass,
          'mail.provider_connections'::regclass, 'mail.remote_resources'::regclass) ORDER BY relname`,
        markers: await sql`SELECT version, name, applied_at FROM mail.schema_migrations ORDER BY version`,
        binding: await sql`SELECT remote_locator, verification_evidence, verified_scope_fingerprint
          FROM mail.provider_bindings WHERE id = ${bindingId}::uuid`,
        connection: await sql`SELECT connector_kind FROM mail.provider_connections WHERE id = ${connectionId}::uuid`,
        resource: await sql`SELECT connector_kind, scope_fingerprint FROM mail.remote_resources WHERE id = ${resourceId}::uuid`,
      });
      const before = await preserved();
      let upgradedChecks: unknown;
      for (let run = 1; run <= 2; run++) {
        await migrate();
        expect(await preserved(), `upgrade ${run}: IMAP rows, heaps and markers preserved`).toEqual(before);
        expect(await legacyRule(), `upgrade ${run}: old path rule retained`).toBeTrue();
        const checks = await sql<{ oid: number; conname: string; convalidated: boolean }[]>`SELECT oid, conname, convalidated FROM pg_constraint
          WHERE conrelid IN ('mail.provider_connections'::regclass, 'mail.remote_resources'::regclass)
            AND conname IN ('provider_connections_connector_kind_check', 'remote_resources_connector_kind_check') ORDER BY conname`;
        expect(checks.map((row) => row.convalidated), `upgrade ${run}: validated`).toEqual([true, true]);
        if (run === 1) upgradedChecks = checks;
        else expect(checks, "upgrade 2: CHECKs not recreated").toEqual(upgradedChecks);
      }
      // A failed concurrent build leaves an invalid index. The builder must replace it, not trust its name.
      await expect(sql`CREATE UNIQUE INDEX CONCURRENTLY binding_folder_refs_jmap_id_idx
        ON mail.binding_folder_refs (binding_id)`.simple().execute(), "upgrade: failed concurrent build fixture").rejects.toThrow();
      expect(await sql`SELECT indisvalid FROM pg_index WHERE indexrelid = 'mail.binding_folder_refs_jmap_id_idx'::regclass`,
        "upgrade: invalid index exists").toEqual([{ indisvalid: false }]);
      await sql`CREATE UNIQUE INDEX CONCURRENTLY binding_folder_refs_imap_path_idx
        ON mail.binding_folder_refs (binding_id, remote_path) WHERE remote_folder_id IS NULL`.simple();
      const mutex = indexMutex();
      const lease = await mutex.acquire({ resource: "mail-indexes" });
      if (!lease) throw new Error("upgrade: could not acquire test index lease");
      try {
        expect(await buildFolderIdentityIndexes(), "upgrade: second index busy").toBe("busy");
        expect(await legacyRule(), "upgrade: one valid index is insufficient").toBeTrue();
        await expect(project([]), "upgrade: projection denied before completion").rejects.toThrow("migration is not ready");
      } finally {
        await mutex.release(lease);
      }
      expect(await buildFolderIdentityIndexes(), "upgrade: replacement built").toBe("built");
      expect(await legacyRule(), "upgrade: old path rule removed").toBeFalse();
      expect(await buildFolderIdentityIndexes(), "upgrade: ready on repetition").toBe("ready");
      expect(await preserved(), "upgrade: index work leaves rows and heaps intact").toEqual(before);
      // Frozen predecessor write: its conflict target remains (binding_id, folder_id).
      await sql`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next)
        VALUES (${bindingId}::uuid, ${folderId}::uuid, 'Renamed', 10, 22)
        ON CONFLICT (binding_id, folder_id) DO UPDATE SET remote_path = EXCLUDED.remote_path, uid_next = EXCLUDED.uid_next`;
      expect(await sql`SELECT remote_path, uid_next::text FROM mail.binding_folder_refs WHERE folder_id = ${folderId}::uuid`,
        "rollback: predecessor read/write").toEqual([{ remote_path: "Renamed", uid_next: "22" }]);
      await expect(sql.begin(async (tx) => {
        await tx`UPDATE mail.binding_folder_refs SET remote_path = 'Renamed' WHERE folder_id = ${otherFolderId}::uuid`;
      }), "rollback: IMAP uniqueness still enforced").rejects.toMatchObject({ constraint: "binding_folder_refs_imap_path_idx" });
    } finally {
      await migrate();
      await buildFolderIdentityIndexes();
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  });

  test("projection: rename, reparent, replacement, rights loss and delta inventory", async () => {
    await migrate();
    expect(["built", "ready"], "projection: schema ready").toContain(await buildFolderIdentityIndexes());
    await seed("jmap");
    try {
      const first = await project([folder("child", "Same", "parent"), folder("parent"), folder("other")]);
      const childId = first.get("child");
      const parentId = first.get("parent");
      const otherId = first.get("other");
      if (!childId || !parentId || !otherId) throw new Error("projection: initial IDs missing");
      await sql`INSERT INTO mail.message_contents (id, short_id, mailbox_id, content_hash, internal_date)
        VALUES (${messageId}::uuid, 'JmpMS1', ${mailboxId}::uuid, ${"b".repeat(64)}, '2026-11-19T12:00:00Z')`;
      const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, remote_id)
        VALUES (${childId}::uuid, ${messageId}::uuid, 'email_1') RETURNING id`;
      if (!ref) throw new Error("projection: message ref missing");
      await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${ref.id}::uuid, ${childId}::uuid, ${messageId}::uuid)`;
      const messageState = () => sql`SELECT ref.id, ref.folder_id, ref.message_id, ref.remote_id, placement.remote_message_ref_id AS placement_id, placement.flags, placement.keywords, placement.deleted_at
        FROM mail.remote_message_refs ref JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
        WHERE ref.id = ${ref.id}::uuid`;
      const before = await messageState();
      const [bindingRef] = await sql<{ id: string }[]>`SELECT id FROM mail.binding_folder_refs WHERE folder_id = ${childId}::uuid`;
      if (!bindingRef) throw new Error("projection: binding ref missing");
      const renamed = { ...folder("child", "Renamed", "other"), subscribed: false, rights: ["read"] };
      const second = await project([renamed], { kind: "delta", missingMailboxIds: [] });
      expect(second.get("child"), "projection: rename retains UUID").toBe(childId);
      expect(await messageState(), "projection: refs and placements retained").toEqual(before);
      expect(await sql`SELECT folder.parent_id, ref.id, ref.remote_path, ref.effective_rights, ref.subscribed,
        ref.rights_source, ref.uid_validity, ref.uid_next, ref.highest_modseq
        FROM mail.folders folder JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id WHERE folder.id = ${childId}::uuid`,
        "projection: ID parent and rights updated").toEqual([{
          parent_id: otherId, id: bindingRef.id, remote_path: "Renamed", effective_rights: ["read"], subscribed: false,
          rights_source: "acl", uid_validity: null, uid_next: null, highest_modseq: null,
        }]);
      expect(await sql`SELECT count(*)::int AS count FROM mail.folders WHERE remote_resource_id = ${resourceId}::uuid AND discovery_state = 'active'`,
        "delta: unobserved parents remain active").toEqual([{ count: 3 }]);
      expect((await project([renamed], { kind: "delta", missingMailboxIds: [] })).get("child"), "projection: replay UUID").toBe(childId);
      const replacement = await project([folder("new", "Renamed")], { kind: "delta", missingMailboxIds: ["child"] });
      expect(replacement.get("new"), "projection: new mailbox ID at old path").not.toBe(childId);
      expect(await sql`SELECT ref.effective_rights, ref.rights_source, ref.missing_since IS NOT NULL AS missing,
        folder.discovery_state, folder.selected_for_sync, folder.sync_status
        FROM mail.binding_folder_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE folder.id = ${childId}::uuid`,
        "delta: explicit removal revokes rights").toEqual([{
          effective_rights: [], rights_source: "unknown", missing: true, discovery_state: "missing", selected_for_sync: false, sync_status: "excluded",
        }]);
      await expect(project([folder("other", "Other", "parent"), folder("parent", "Parent", "other")], { kind: "delta", missingMailboxIds: [] }),
        "projection: parent cycle rolls back").rejects.toThrow("parent cycle");
      await expect(project([folder("unknown", "Unknown", "absent")]), "projection: missing parent rolls back").rejects.toThrow("missing parent");
      await project([folder("new", "Renamed")]);
      expect(await sql`SELECT count(*)::int AS count FROM mail.binding_folder_refs WHERE binding_id = ${bindingId}::uuid AND missing_since IS NULL`,
        "snapshot: unobserved folders missing").toEqual([{ count: 1 }]);
      expect(await messageState(), "projection: missing folder does not rewrite message addresses").toEqual(before);
      await expect(sql.begin(async (tx) => {
        await tx`UPDATE mail.binding_folder_refs SET remote_folder_id = 'new' WHERE folder_id = ${parentId}::uuid`;
      }), "projection: duplicate ID rejected on real table").rejects.toMatchObject({ constraint: "binding_folder_refs_jmap_id_idx" });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  });
});
