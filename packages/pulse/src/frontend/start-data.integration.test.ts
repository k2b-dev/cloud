import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import baseRoutes from "../api/routes/bases";
import type { PulseNav } from "../contracts";
import { newShortId } from "../lib/short-id";
import { seedActiveBaseStore } from "../service/base-store.test-fixture";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { loadPulseWorkspacePageData } from "./[baseId]/page-data";
import { PULSE_BASE_COOKIE } from "./base-cookie";
import { loadPulseStart } from "./start-data";

/**
 * Where `/app/pulse` leads and what it costs: the remembered base while the person may read it, else the newest one,
 * else the start with the deletions its admin follows; one statement each way. The sidebar's search route and the
 * page of a base in deletion are bounded and pinned the same way.
 */
suiteFor("database", "valkey")("Pulse start", () => {
  const people: string[] = [];
  const grants: string[] = [];
  const bases: string[] = [];
  // the member reads three bases; one more is someone else's, one is being deleted under the member's admin grant
  const older = newShortId();
  const newest = newShortId();
  const foreign = newShortId();
  const deleting = newShortId();
  let member = "";
  let newcomer = "";
  let reader = "";

  const person = async (name: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`start-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
    people.push(row!.id);
    return row!.id;
  };
  const grant = async (baseId: string, who: string, permission: "read" | "admin") => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${who}::uuid, ${permission}) RETURNING id`;
    grants.push(row!.id);
    await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${row!.id}::uuid)`;
  };
  // changed far ahead of every other suite's bases, so a base another suite shares with everyone never is the newest
  const base = async (shortId: string, name: string, at: string, owner: string, permission: "read" | "admin", deleted = false) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO pulse.bases(short_id, name, timezone, updated_at, deletion_started_at)
      VALUES (${shortId}, ${name}, 'Europe/Berlin', ${at}::timestamptz, ${deleted ? at : null}::timestamptz) RETURNING id`;
    bases.push(row!.id);
    await grant(row!.id, owner, permission);
    return row!.id;
  };

  beforeAll(async () => {
    member = await person("Start member");
    newcomer = await person("Start newcomer");
    reader = await person("Start reader");
    const stranger = await person("Start stranger");
    await base(older, "Werkstatt alt", "2099-01-20T09:00:00Z", member, "read");
    await base(newest, "Werkstatt neu", "2099-01-25T09:00:00Z", member, "read");
    await base(foreign, "Fremde Basis", "2099-01-26T09:00:00Z", stranger, "admin");
    const gone = await base(deleting, "Altes Lager", "2099-01-27T09:00:00Z", member, "admin", true);
    // its store runs the deletion (a base without a store row counts as failed)
    await seedActiveBaseStore(gone);
    // someone who only reads the base in deletion
    await grant(gone, reader, "read");
    // the newcomer reads nothing but administers a base in deletion
    await base(newShortId(), "Testbasis Herbst", "2099-01-24T09:00:00Z", newcomer, "admin", true);
  });
  afterAll(async () => {
    if (bases.length) await sql`DELETE FROM pulse.bases WHERE id = ANY(${sql.array(bases, "UUID")})`;
    if (grants.length) await sql`DELETE FROM auth.access WHERE id = ANY(${sql.array(grants, "UUID")})`;
    if (people.length) await sql`DELETE FROM auth.users WHERE id = ANY(${sql.array(people, "UUID")})`;
  });

  /** Runs `loader` in a request for `path` as `who`, with `cookie`; the second, measured run has warm caches. */
  const measure = async <T>(
    who: string,
    path: string,
    pattern: string,
    loader: (c: Context<AuthContext>) => Promise<T>,
    cookie?: string,
  ) => {
    const identity = adminFixtureIdentity(who, false);
    let result: T | undefined;
    const load = () =>
      new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", identity.actor);
          c.set("accessSubject", identity.accessSubject);
          await next();
        })
        .get(pattern, async (c) => {
          result = await loader(c);
          return c.text("ok");
        })
        .request(`https://cloud.example.test${path}`, cookie ? { headers: { cookie: `${PULSE_BASE_COOKIE}=${cookie}` } } : {});
    await load();
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => load());
      return { statements, result: result as T };
    } finally {
      await meter.close();
    }
  };
  const start = (who: string, cookie?: string) => measure(who, "/app/pulse", "/app/pulse", loadPulseStart, cookie);

  test("the remembered base opens while the person may read it; else the newest; else the start", async () => {
    // the remembered base, even when it is not the newest
    const remembered = await start(member, older);
    expect(remembered.result).toEqual({ kind: "open", href: `/app/pulse/${older}` });
    // one statement: the sidebar's own read answers which base is open and which is newest
    expect(remembered.statements).toHaveLength(1);
    // no cookie, a base someone else holds, a base being deleted, a word that is no public id: the newest readable base
    for (const cookie of [undefined, foreign, deleting, "../../admin"]) {
      const next = await start(member, cookie);
      expect({ cookie, result: next.result }).toEqual({ cookie, result: { kind: "open", href: `/app/pulse/${newest}` } });
      expect(next.statements).toHaveLength(1);
    }
    // nothing to read: the start, with the deletion the newcomer administers
    const first = await start(newcomer);
    expect(first.result.kind).toBe("start");
    expect(first.result.kind === "start" && first.result.deleting.map((entry) => entry.name)).toEqual(["Testbasis Herbst"]);
    expect(first.statements).toHaveLength(1);
  }, 60_000);

  test("the sidebar's search route answers in one statement, bounded, and names deletions only to their admins", async () => {
    const identity = adminFixtureIdentity(member, false);
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("actor", identity.actor);
        c.set("accessSubject", identity.accessSubject);
        await next();
      })
      .route("/api/pulse", baseRoutes);
    const ask = async (q: string) => (await app.request(`/api/pulse/nav?q=${encodeURIComponent(q)}`)).json() as Promise<PulseNav>;
    await ask("werkstatt");
    const meter = await meterSql();
    try {
      let answer: PulseNav | undefined;
      const statements = await meter.during(async () => {
        answer = await ask("werkstatt");
      });
      expect(statements).toHaveLength(1);
      // (among this suite's bases: another suite may share one of its own with everyone for a moment)
      expect(answer?.bases.filter((entry) => [older, newest].includes(entry.id)).map((entry) => entry.name)).toEqual([
        "Werkstatt neu",
        "Werkstatt alt",
      ]);
      expect(answer?.deleting).toEqual([]);
    } finally {
      await meter.close();
    }
    // the deletion the member administers matches its own name; a search with % or _ matches them literally
    expect((await ask("lager")).deleting.map((entry) => [entry.name, entry.state])).toEqual([["Altes Lager", "deleting"]]);
    expect((await ask("%")).bases).toEqual([]);
    expect((await app.request(`/api/pulse/nav?q=${"x".repeat(201)}`)).status).toBe(400);
  }, 60_000);

  test("a base in deletion is its admin's page in a pinned number of statements, and gone for readers", async () => {
    const page = await measure(member, `/app/pulse/${deleting}`, "/app/pulse/:baseId", loadPulseWorkspacePageData);
    expect(page.result).toMatchObject({ kind: "deleting", base: { id: deleting, name: "Altes Lager", state: "deleting" } });
    // public id, the one grant read, the sidebar, and the base as every base page reads it (row, store, member count, the
    // admin's first members and their names); no source, attention or settings read follows (28.11.2026)
    const pinned = 9;
    if (page.statements.length !== pinned)
      console.info(`pulse deleting page:\n${page.statements.map((text, index) => `  ${index + 1}. ${text}`).join("\n")}`);
    expect(page.statements).toHaveLength(pinned);
    // someone who only reads it finds no page: for them the base is gone
    const gone = await measure(reader, `/app/pulse/${deleting}`, "/app/pulse/:baseId", loadPulseWorkspacePageData);
    expect(gone.result).toEqual({ kind: "error", status: 404 });
    // nor does it stand in their sidebar
    const readerStart = await start(reader);
    expect(readerStart.result).toEqual({ kind: "start", deleting: [] });
  }, 60_000);
});
