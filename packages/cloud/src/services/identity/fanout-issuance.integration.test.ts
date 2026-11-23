import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPair } from "jose";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { appAccess } from "../../contracts/app-access";
import type { AppRegistryEntry } from "../../contracts/registry";
import { sql } from "../../runtime/clients";
import { discoverableAppEntries } from "../app-discovery";
import type { InvocationAuthority } from "./invocation-token";
import { prepareFanoutIssuance, resolveIssuanceAuthority } from "./issue-invocation";

const suite = suiteFor("database");
const userId = crypto.randomUUID();
const authority: InvocationAuthority = {
  sub: userId,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: userId,
  credential_kind: "session",
  scopes: [],
};

/** Apps of every rule that asks the database or nothing: unconfigured grants, fixed rules, and roles. */
const registry = (count: number): AppRegistryEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `fanout-${String(index).padStart(2, "0")}`,
    name: `Fan-out ${index}`,
    icon: "ti ti-box",
    description: "Fan-out fixture",
    baseUrl: `http://fanout-${index}.test:3000`,
    routes: [],
    access: [appAccess.grants({ until: appAccess.signedIn() }), appAccess.signedIn(), appAccess.noGuests(), appAccess.roles(["user"])][
      index % 4
    ],
  }));

let signer: { key: CryptoKey; kid: string; signUntil: Date };

suite("access model step 10: search and dashboard fan-out", () => {
  beforeAll(async () => {
    signer = { key: (await generateKeyPair("RS256")).privateKey, kid: crypto.randomUUID(), signUntil: new Date(Date.now() + 600_000) };
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${userId}, ${userId}, 'local', 'user', 'Fan-out caller')`;
  });
  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  });

  /**
   * One request as search and the dashboard run it: discovery with the request's authority, then one prepared issuer
   * that signs a token per admitted target. Signing itself needs no database.
   */
  const fanout = async (count: number) => {
    const apps = registry(count);
    const request = await resolveIssuanceAuthority(authority, "core", sql, []);
    if (!request) throw new Error("The fixture person did not resolve");
    const entries = apps.map((app) => ({ appId: app.id }));
    const meter = await meterSql();
    try {
      let signed = 0;
      const statements = await meter.during(async () => {
        const admitted = await discoverableAppEntries(request, entries, async () => apps);
        const sign = await prepareFanoutIssuance(
          { authority, callingAppId: "core", entries: admitted },
          { groupsAdmin: [], registry: async () => apps },
        );
        for (const entry of admitted) {
          await sign({
            targetAppId: entry.appId,
            operation: "capability.query:search",
            schemaHash: null,
            signer,
            issuer: "https://cloud.test",
          });
          signed += 1;
        }
      });
      return { statements, signed };
    } finally {
      await meter.close();
    }
  };

  test("the person and the app rules cost the same statements for 1 and 16 target apps", async () => {
    const one = await fanout(1);
    const many = await fanout(16);
    expect(one.signed).toBe(1);
    expect(many.signed).toBe(16);
    // Fixed per request, never per target: discovery's rule batch, the issuing person reloaded once (the person and
    // the installation's settings), and the issuer's rule batch for that reloaded person, which can lack the admin role.
    expect(many.statements).toEqual(one.statements);
    expect(many.statements.map((statement) => statement.slice(0, 32))).toEqual([
      "SELECT requested.app_id, s.confi",
      "SELECT u.*, (SELECT cache_versio",
      "SELECT (SELECT value FROM settin",
      "SELECT requested.app_id, s.confi",
    ]);
  });
});
