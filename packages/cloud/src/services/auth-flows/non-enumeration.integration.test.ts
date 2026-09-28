import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { createAuthRoutes } from "../../api/auth";
import * as settings from "../settings";
import type { AuthNotificationSender } from "./notification-sender";

const suite = suiteFor("database", "valkey");
const prefix = `enum-${crypto.randomUUID().slice(0, 8)}`;
const freeIpa = {
  "freeipa.enable": true,
  "freeipa.url": "fixture.invalid",
  "freeipa.service_user": "fixture",
  "freeipa.service_password": "fixture-only",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["cloud-users"],
};

// Every delivery blocks until the test releases it. A route that waited for
// the lookup or the delivery could not answer while deliveries are pending.
let release = Promise.withResolvers<void>();
const sent: { kind: string; email: string }[] = [];
const blocked =
  (kind: string) =>
  async ({ email }: { email: string }) => {
    sent.push({ kind, email });
    await release.promise;
    return { id: "test", status: "queued" as const };
  };
const sender: AuthNotificationSender = {
  sendMagicLink: blocked("magic-link"),
  sendIpaLoginHint: blocked("ipa-hint"),
  sendPasswordReset: blocked("password-reset"),
};
const routes = new Hono().route("/auth", createAuthRoutes(sender));
let client = 0;
const post = async (path: string, body: Record<string, unknown>) => {
  const response = await routes.request(`/auth${path}`, {
    method: "POST",
    // A distinct client per request keeps the per-client rate limit out of the comparison.
    headers: { "content-type": "application/json", "x-forwarded-for": `${prefix}-${client++}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const account = async (provider: "local" | "ipa", profile: "user" | "guest", mail: string | null) => {
  const uid = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO auth.users (uid, provider, profile, mail, sn) VALUES (${uid}, ${provider}, ${profile}, ${mail}, ${prefix})`;
  return { uid, mail: mail ?? "" };
};
const waitForDeliveries = async (count: number) => {
  const deadline = Date.now() + 5_000;
  while (sent.length < count && Date.now() < deadline) await Bun.sleep(10);
};

suite("sign-in and reset requests never reveal accounts", () => {
  beforeAll(async () => {
    for (const name of ["auth", "settings", "audit", "logging"])
      await (await import(`../../../../core/src/migrate/core/${name}.ts`)).migrate();
  }, 30000);
  beforeEach(async () => {
    release = Promise.withResolvers<void>();
    sent.length = 0;
    await settings.set("user.allow_self_registration", false);
  });
  afterAll(async () => {
    release.resolve();
    for (const key of [...Object.keys(freeIpa), "user.allow_self_registration"]) await settings.remove(key);
    await sql`DELETE FROM auth.users WHERE sn = ${prefix}`;
  });

  test("email sign-in answers alike for existing, unknown, mail-less and FreeIPA accounts", async () => {
    const full = await account("local", "user", `full.${prefix}@example.test`);
    const guest = await account("local", "guest", `guest.${prefix}@example.test`);
    const mailless = await account("local", "user", null);
    const directory = await account("ipa", "user", `ipa.${prefix}@example.test`);
    const requests = [
      { email: full.mail, category: "login" },
      { email: full.uid, category: "login" },
      { email: guest.mail, category: "guest" },
      { email: mailless.uid, category: "login" },
      { email: directory.mail },
      { email: `unknown.${prefix}@example.test`, category: "guest" },
      { email: `${prefix}-unknown`, category: "login" },
    ];
    const responses = [];
    for (const body of requests) responses.push(await post("/email-login", body));
    expect(new Set(responses.map((response) => JSON.stringify(response))).size).toBe(1);
    expect(responses[0]).toMatchObject({ status: 200, body: { message: expect.stringContaining("contact an administrator") } });

    // The deliveries for the existing accounts start only after every answer was sent.
    await waitForDeliveries(4);
    expect(sent.map((entry) => `${entry.kind}:${entry.email}`).sort()).toEqual(
      [`ipa-hint:${directory.mail}`, `magic-link:${full.mail}`, `magic-link:${full.mail}`, `magic-link:${guest.mail}`].sort(),
    );
    release.resolve();
  });

  test("password reset answers alike for eligible, unknown and local addresses", async () => {
    for (const [key, value] of Object.entries(freeIpa)) await settings.set(key, JSON.stringify(value));
    const directory = await account("ipa", "user", `reset.${prefix}@example.test`);
    const local = await account("local", "user", `reset-local.${prefix}@example.test`);
    const responses = [];
    for (const email of [directory.mail, `reset-unknown.${prefix}@example.test`, local.mail])
      responses.push(await post("/password-reset/request", { email, acceptedAgb: true }));
    expect(new Set(responses.map((response) => JSON.stringify(response))).size).toBe(1);
    expect(responses[0]).toMatchObject({ status: 200, body: { message: expect.stringContaining("contact an administrator") } });

    await waitForDeliveries(1);
    expect(sent).toEqual([{ kind: "password-reset", email: directory.mail }]);
    release.resolve();
  });
});
