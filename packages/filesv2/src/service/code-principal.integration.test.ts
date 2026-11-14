import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { RequestActor } from "@k2b/cloud/server";
import { accounts, serviceAccounts } from "@k2b/cloud/services";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { bindings } from "../data/bases";
import { migrate } from "../migrate";
import { FilesError } from "./errors";
import { checkStorage, grantStorage, revokeStorage, storagePermission } from "./machine-access";

const suite = suiteFor("database", "nats", "valkey");
suite("Files Code principals use normal storage grants", () => {
  beforeAll(migrate);
  test("a saved target grants nothing; its ordinary grant enables view/edit until revoked", async () => {
    const suffix = crypto.randomUUID();
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`files-code-admin-${suffix}`}, 'local', 'user', 'Storage manager', true) RETURNING id`;
    const [machine] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`files-code-${suffix}`}, 'code') RETURNING id`;
    if (!person || !machine) throw new Error("Missing identity fixture");
    const user = await accounts.users.get({ id: person.id });
    const serviceAccount = await serviceAccounts.get({ id: machine.id });
    if (!user || !serviceAccount) throw new Error("Missing identity");
    const manager: RequestActor = { kind: "user", user };
    // The invocation resolver projects this non-manager ceiling for a verified Code run.
    const actor: RequestActor = { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["read", "write"] };
    const [base] = await sql<{ id: string }[]>`INSERT INTO filesv2.bases (area, kind, identity_id, identity_name, root, path)
      VALUES ('cloud', 'users', ${machine.id}::uuid, 'Storage', 'fixture', ${suffix}) RETURNING id`;
    if (!base) throw new Error("Missing storage fixture");
    const settingKey = `a1.files.target.${suffix}`;
    const accessIds: string[] = [];
    try {
      await sql`INSERT INTO filesv2.machine_storage (base_id, owner_id, owner_kind, owner_name, server_url)
        VALUES (${base.id}::uuid, ${crypto.randomUUID()}::uuid, 'agent', 'Storage owner', 'https://filegate.example.test')`;
      await sql`INSERT INTO settings.entries (key, value) VALUES (${settingKey}, ${JSON.stringify(base.id)})`;
      const route = new Hono()
        .onError((error, c) =>
          error instanceof FilesError ? c.json({ code: error.code }, error.status) : c.json({ message: "Failed" }, 500),
        )
        .get("/configured-target", async (c) => {
          const [setting] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${settingKey}`;
          const target = await bindings.byId(JSON.parse(setting!.value));
          if (!target) return c.notFound();
          await checkStorage(actor, target, "", "read");
          return c.json({ allowed: true });
        });
      expect((await route.request("/configured-target")).status).toBe(403);
      const principal = { type: "service_account" as const, serviceAccountId: machine.id };
      const grant = await grantStorage(manager, base.id, "", principal, "read");
      accessIds.push(grant.id);
      const binding = await bindings.byId(base.id);
      if (!binding) throw new Error("Missing binding");
      expect(await storagePermission(actor, binding, "")).toBe("read");
      expect((await route.request("/configured-target")).status).toBe(200);
      expect((await grantStorage(manager, base.id, "", principal, "write")).id).toBe(grant.id);
      expect(await storagePermission(actor, binding, "")).toBe("write");
      expect(await storagePermission({ ...actor, scopes: ["read"] }, binding, "")).toBe("read");
      await expect(grantStorage(manager, base.id, "", principal, "admin")).rejects.toMatchObject({ status: 400 });
      await revokeStorage(manager, base.id, grant.id);
      expect((await route.request("/configured-target")).status).toBe(403);
    } finally {
      await sql`DELETE FROM settings.entries WHERE key = ${settingKey}`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      await sql`DELETE FROM filesv2.machine_storage WHERE base_id = ${base.id}::uuid`;
      await sql`DELETE FROM filesv2.bases WHERE id = ${base.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${machine.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
    }
  });
});
