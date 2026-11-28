import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { accounts, appApproval, audit, coreSettings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { meterSql, type SqlMeter } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor, useMigratedDatabase } from "../../../../../scripts/fixtures/test-infra";
// a real Core identity authority, so the fixture can sign in with a browser session
import "../../../../../scripts/fixtures/authorization-preload";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// What one first view of each account page costs the database, as the server renders it in the real Cloud shell: the
// page's own reads and the shell's, with real services. Settings come from the settings cache in a running Cloud, so
// they are answered here without the database. The sign-in itself (session lookup) belongs to the platform, not to
// these pages, and is outside the window.
const root = mkdtempSync(join(tmpdir(), "core-account-pages-sql-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const pages = {
  "/me": (await import("./page")).default,
  "/me/security": (await import("./security.page")).default,
  "/me/notifications": (await import("./notifications.page")).default,
  "/me/activity": (await import("./activity.page")).default,
} as const;
type Path = keyof typeof pages;

/** Invented account. */
const userId = "ac000000-0000-4000-8000-000000000042";

suiteFor(
  "database",
  "nats",
  "valkey",
)("account pages: statements per first view", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let meter: SqlMeter;
  let user: User;
  let settings: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
  /** A browser session, so the security page lists the devices that confirm sign-ins. */
  let sessionToken = "";
  beforeAll(async () => {
    database = await useMigratedDatabase("core_account_pages");
    settings = spyOn(coreSettings, "get").mockImplementation(
      async (key) => (key === "app.name" ? "Cloud" : key === "app.url" ? "https://cloud.example.test" : undefined) as never,
    );
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,'kbeispiel','local','user','Kim Beispiel')`;
    // a working account: passkeys, direct and nested groups, and account events, so a query per row would show
    for (const name of ["Arbeitslaptop", "Telefon", "Sicherheitsschlüssel"])
      await sql`INSERT INTO auth.webauthn_credentials (user_id, name, credential_id, public_key)
        VALUES (${userId}::uuid, ${name}, ${crypto.randomUUID()}, ${Buffer.from("fixture-key")})`;
    const groups: string[] = [];
    for (const name of ["team-design", "redaktion", "verein"]) {
      const [row] = await sql<
        { id: string }[]
      >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`local:${name}`}, 'local', ${name}) RETURNING id`;
      groups.push(row!.id);
    }
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${groups[0]!}::uuid), (${userId}::uuid, ${groups[1]!}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${groups[2]!}::uuid, ${groups[0]!}::uuid)`;
    for (const action of ["accounts.user.update", "accounts.user.change_own_password", "accounts.user.update"])
      await audit.record({ action, outcome: "allowed", actor: { userId, uid: "kbeispiel", provider: "local" } });
    // three API keys of the person
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name, kind, status, delegated_user_id)
      VALUES ('Kim Beispiel', 'user_delegated', 'active', ${userId}::uuid) RETURNING id`;
    for (const index of [1, 2, 3])
      await sql`INSERT INTO auth.service_account_credentials(service_account_id, name, token_prefix, secret_hash)
        VALUES (${account!.id}::uuid, ${`Schlüssel ${index}`}, ${`fixture-key-${index}`}, ${`hash-${index}`})`;
    // three actions that wait for the person's approval
    for (const index of [1, 2, 3])
      await sql`INSERT INTO approvals.requests(app_id, action, requester_kind, requester_ref, requester_app_id, subject_id,
          approver_user_id, assurance, sentence, args_digest, review_digest, status, approver_auth_epoch, expires_at)
        SELECT ${`fixture-${index}`}, 'write', 'assistant_turn', ${`fixture-turn-${index}`}, ${`fixture-${index}`}, id, id, 'standard',
          ${`Aktion ${index} ausführen`}, 'args', 'review', 'pending', auth_epoch, now() + interval '1 day'
        FROM auth.users WHERE id = ${userId}::uuid`;
    // two kinds of notifications and three deliveries of them, one failed
    await sql`INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind, active)
      VALUES ('fixture.digest', 'fixture', 'digest', 'Zusammenfassung', 'Jeden Morgen', 'user', true),
        ('fixture.reply', 'fixture', 'reply', 'Antwort', 'Wenn jemand antwortet', 'user', true)`;
    for (const index of [1, 2, 3]) {
      const [event] = await sql<{ id: string }[]>`INSERT INTO notifications.events(definition_id, recipient_user_id, recipient_key,
          idempotency_key, title, target_href)
        VALUES (${index === 1 ? "fixture.digest" : "fixture.reply"}, ${userId}::uuid, ${`user:${userId}`}, ${`fixture-${index}`},
          ${`Meldung ${index}`}, '/app/fixture') RETURNING id`;
      await sql`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, required, status, attempt_count)
        VALUES (${event!.id}::uuid, 'email', ${`email-${index}`}, 'k***@example.test', false, ${index === 3 ? "failed" : "delivered"}, 1)`;
    }
    // three phones with the app, and three devices that confirm sign-ins (listed for a browser session)
    for (const index of [1, 2, 3])
      await sql`INSERT INTO auth.pwa_devices (id, user_id, name, platform, auth_epoch, secret_hash, rotated_at)
        SELECT gen_random_uuid(), id, ${`Telefon ${index}`}, 'other', auth_epoch, ${"0".repeat(64)}, now()
        FROM auth.users WHERE id = ${userId}::uuid`;
    const { issuer } = await appApproval.config(false);
    for (const index of [1, 2, 3]) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
      await sql`INSERT INTO auth.app_devices(id, issuer, user_id, name, public_key, assisted, enrolled_by)
        VALUES (gen_random_uuid(), ${issuer}, ${userId}::uuid, ${`Gerät ${index}`}, ${JSON.stringify(publicKey)}::text::jsonb, false,
          ${userId}::uuid)`;
    }
    sessionToken = await createTestSession(userId);
    const found = await accounts.users.get({ id: userId });
    if (!found) throw new Error("Missing account fixture");
    user = found;
    meter = await meterSql();
  }, 180_000);
  afterAll(async () => {
    await meter?.close();
    settings?.mockRestore();
    await database?.drop();
  });

  const open = async (path: Path, query = "") => {
    const app = new Hono()
      .use("*", async (c, next) => {
        c.set("user" as never, user as never);
        c.set("actor" as never, { kind: "user", user } as never);
        c.set("accessSubject" as never, { type: "user", userId } as never);
        c.set("credentialKind" as never, "session" as never);
        // the mobile app runs, so the security page lists the phones
        c.set(
          "runtime" as never,
          {
            apps: [{ id: "pwa", name: "App", icon: "ti ti-device-mobile", description: "", baseUrl: "http://pwa:3000", routes: ["/pwa"] }],
          } as never,
        );
        await next();
      })
      .get(path, ...(pages[path] as (typeof pages)["/me"]));
    let status = 0;
    const statements = await meter.during(async () => {
      const response = await app.request(`https://cloud.example.test${path}${query}`, {
        headers: { Cookie: `cloud.locale=de; session_token=${sessionToken}` },
      });
      status = response.status;
      await response.text();
    });
    expect(status).toBe(200);
    return statements;
  };

  test("each page reads what its first view shows in a fixed number of statements", async () => {
    const views = [
      ["/me", ""],
      ["/me", "?groups=all"],
      ["/me/security", ""],
      ["/me/notifications", ""],
      ["/me/activity", ""],
      ["/me/activity", "?kind=deliveries"],
      ["/me/activity", "?kind=sign-ins"],
    ] as const;
    // A running Cloud keeps some settings in its process cache; one view of each page first fills it the way earlier
    // requests did, so the counts are those of every later view and do not depend on the order.
    for (const [path, query] of views) await open(path, query);
    const counts: Record<string, number> = {};
    const seen: Record<string, string[]> = {};
    for (const [path, query] of views) {
      const statements = await open(path, query);
      counts[`${path}${query}`] = statements.length;
      seen[`${path}${query}`] = statements;
    }
    // Each count holds with three rows of every list (passkeys, groups, events, keys, approvals, deliveries, phones and
    // devices): one statement per list, never one per row, all of a page in one round. Three of each are the shell's
    // (rail, its shortcuts, the screen preferences); the security page also checks the browser session (one). It reads the
    // app approval settings twice, once for its offer and once inside the device list (platform service).
    const budget = {
      "/me": 10,
      "/me?groups=all": 11,
      "/me/security": 12,
      "/me/notifications": 5,
      "/me/activity": 7,
      "/me/activity?kind=deliveries": 7,
      "/me/activity?kind=sign-ins": 5,
    };
    // a different count names its statements, so the reason is in the log
    if (!Bun.deepEquals(counts, budget)) process.stdout.write(`account page statements: ${JSON.stringify(seen, null, 2)}\n`);
    expect(counts).toEqual(budget);
  }, 60_000);
});
