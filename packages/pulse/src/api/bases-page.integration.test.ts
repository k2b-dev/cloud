import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { seedActiveBaseStore } from "../service/base-store.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import pulseApi from ".";

/** The base list is one bounded page: a person with many bases pages through them or searches by name. */
suiteFor(
  "database",
  "nats",
  "valkey",
)("Pulse base list pages", () => {
  let settings: ReturnType<typeof settingsFixture>;
  let memberId: string, accessId: string, cookie: string;
  const baseIds: string[] = [];
  beforeAll(async () => {
    settings = settingsFixture();
    // the API answers once a store is configured; the list itself never reaches it
    settings.values["pulse.clickhouse_connection"] = JSON.stringify({
      url: "http://127.0.0.1:1",
      user: "fixture",
      password: "fixture-password",
    });
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`page-list-${crypto.randomUUID()}`}, 'local', 'user', 'Page lister') RETURNING id`;
    memberId = person!.id;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id, permission) VALUES (${memberId}::uuid, 'read') RETURNING id`;
    accessId = grant!.id;
    for (const name of ["Werkstatt", "Lager", "Kühlhaus"]) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO pulse.bases(short_id, name, timezone) VALUES (${newShortId()}, ${name}, 'Europe/Berlin') RETURNING id`;
      baseIds.push(row!.id);
      await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${row!.id}::uuid, ${accessId}::uuid)`;
    }
    await seedActiveBaseStore(...baseIds);
    cookie = `session_token=${await createTestSession(memberId)}`;
  });
  afterAll(async () => {
    settings.restore();
    for (const id of baseIds) await sql`DELETE FROM pulse.bases WHERE id=${id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (memberId) await sql`DELETE FROM auth.users WHERE id=${memberId}::uuid`;
  });
  const list = async (query: string) => {
    const response = await pulseApi.request(`/bases${query}`, { headers: { cookie, "x-forwarded-for": uniqueCallerAddress() } });
    const body: unknown = await response.json();
    return { status: response.status, body, names: response.ok ? (body as { name: string }[]).map((base) => base.name) : [] };
  };

  test("the list pages by limit and offset, searches by name and refuses a page larger than 100", async () => {
    const first = await list("?limit=2");
    expect({ status: first.status, body: first.status === 200 ? null : first.body }).toEqual({ status: 200, body: null });
    const rest = await list("?limit=2&offset=2");
    expect(first.names).toHaveLength(2);
    expect(rest.names).toHaveLength(1);
    expect([...first.names, ...rest.names].sort()).toEqual(["Kühlhaus", "Lager", "Werkstatt"]);
    expect((await list("?q=lag")).names).toEqual(["Lager"]);
    expect((await list("?limit=101")).status).toBe(400);
  });
});
