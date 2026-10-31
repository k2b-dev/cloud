import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { sql } from "../../runtime/clients";
import { links } from "./index";
import { cleanupLinksBatch, createLinksStore, LINK_CLEANUP_BATCH, setupLinks } from "./store";

const suite = databaseSuite();
const invalid = { ok: false, error: { code: "LINK_INVALID" } } as const;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

suite("application one-time links", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let store: ReturnType<typeof createLinksStore>;
  let other: ReturnType<typeof createLinksStore>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("one_time_links");
    store = createLinksStore(sql, "links-service-test");
    other = createLinksStore(sql, "links-other-test");
    await Promise.all([setupLinks(sql), setupLinks(sql), setupLinks(sql)]);
  });
  beforeEach(async () => {
    await sql`DELETE FROM platform._cloud_links WHERE package IN ('links-service-test', 'links-other-test')`;
  });
  afterEach(() => clearProcessApplicationId());
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });

  test("restarting an app does not wait for an open link transaction", async () => {
    const startupDb = new SQL(fresh.url, { max: 1 });
    try {
      await startupDb`SET statement_timeout = '1s'`.simple();
      await sql.begin(async (tx) => {
        await store.create({ purpose: "portal.login", subject: "customer", ttl: 900 }, { tx });
        await setupLinks(startupDb);
      });
    } finally {
      await startupDb.close();
    }
  });

  test("stores only a hash, uses DB time, and round-trips app-defined subjects", async () => {
    const { token, expiresAt } = await store.create({ purpose: "login", subject: "mia\0@example.test", ttl: 900 });
    expect(token).toMatch(/^cl_[A-Za-z0-9_-]{43}$/);
    const [row] = await sql<
      { token_hash: string; created_at: Date; expires_at: Date }[]
    >`SELECT * FROM platform._cloud_links WHERE package='links-service-test'`;
    if (!row) throw new Error("missing stored link");
    expect(row.token_hash).toBe(digest(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.expires_at).toEqual(expiresAt);
    expect(expiresAt.getTime() - (row?.created_at.getTime() ?? 0)).toBe(900000);
    expect(await store.redeem(token, { purpose: "login" })).toEqual({
      ok: true,
      data: { subject: "mia\0@example.test", createdAt: row.created_at },
    });
  });

  test("parallel attempts redeem exactly once", async () => {
    const { token } = await store.create({ purpose: "login", subject: "customer", ttl: 60 });
    const results = await Promise.all(Array.from({ length: 16 }, () => store.redeem(token, { purpose: "login" })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(Array.from({ length: 15 }, () => invalid));
  });

  test("wrong, expired, used, other-purpose, other-package and malformed tokens have one result", async () => {
    const { token } = await store.create({ purpose: "login", subject: "customer", ttl: 60 });
    expect(await store.redeem(token, { purpose: "invite" })).toEqual(invalid);
    expect(await other.redeem(token, { purpose: "login" })).toEqual(invalid);
    for (const bad of ["", "cl_short", `cl_${"a".repeat(43)}`, `cl_${"A".repeat(42)}B`, `${token}x`]) {
      expect(await store.redeem(bad, { purpose: "login" })).toEqual(invalid);
    }
    expect(await store.redeem(token, { purpose: "\0" })).toEqual(invalid);
    await sql`UPDATE platform._cloud_links SET expires_at=statement_timestamp() - interval '1 second' WHERE package='links-service-test'`;
    expect(await store.redeem(token, { purpose: "login" })).toEqual(invalid);
    const fresh = await store.create({ purpose: "login", subject: "customer", ttl: 60 });
    expect((await store.redeem(fresh.token, { purpose: "login" })).ok).toBe(true);
    expect(await store.redeem(fresh.token, { purpose: "login" })).toEqual(invalid);
  });

  test("peek twice consumes nothing, returns expiry, and rejects used, expired, wrong-purpose and malformed credentials", async () => {
    const created = await store.create({ purpose: "portal.login", subject: "customer", ttl: 900 });
    const peeked = await store.peek(created.token, { purpose: "portal.login" });
    expect(peeked).toMatchObject({ ok: true, data: { subject: "customer", expiresAt: created.expiresAt } });
    expect(await store.peek(created.token, { purpose: "portal.login" })).toEqual(peeked);
    expect(await store.peek(created.token, { purpose: "invoice.approval" })).toEqual(invalid);
    expect(await other.peek(created.token, { purpose: "portal.login" })).toEqual(invalid);
    for (const token of ["", "cl_short", `cl_${"A".repeat(43)}`, `${created.token}x`]) {
      expect(await store.peek(token, { purpose: "portal.login" })).toEqual(invalid);
    }
    expect(await store.peek(created.token, { purpose: "\0" })).toEqual(invalid);
    expect((await store.redeem(created.token, { purpose: "portal.login" })).ok).toBe(true);
    expect(await store.peek(created.token, { purpose: "portal.login" })).toEqual(invalid);
    expect(await store.redeem(created.token, { purpose: "portal.login" })).toEqual(invalid);
    const expired = await store.create({ purpose: "portal.login", subject: "customer", ttl: 60 });
    await sql`UPDATE platform._cloud_links SET expires_at=clock_timestamp() - interval '1 second'
      WHERE package='links-service-test' AND token_hash=${digest(expired.token)}`;
    expect(await store.peek(expired.token, { purpose: "portal.login" })).toEqual(invalid);
  });

  test("peek racing redemption never consumes a link or permits a second redemption", async () => {
    const { token } = await store.create({ purpose: "portal.login", subject: "customer", ttl: 900 });
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const [peeked, redeemed] = await Promise.all([
          store.peek(token, { purpose: "portal.login" }),
          store.redeem(token, { purpose: "portal.login" }),
        ]);
        expect(peeked.ok ? peeked.data.subject === "customer" : peeked.error.code === "LINK_INVALID").toBe(true);
        return redeemed;
      }),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await store.peek(token, { purpose: "portal.login" })).toEqual(invalid);
  });

  test("a transaction begun before expiry cannot redeem after expiry", async () => {
    const { token } = await store.create({ purpose: "portal.login", subject: "customer", ttl: 900 });
    await sql.begin(async (tx) => {
      await tx`SELECT transaction_timestamp()`;
      // Move the fixture's expiry between transaction start and this statement, without sleeping.
      await tx`UPDATE platform._cloud_links SET expires_at=clock_timestamp()
        WHERE package='links-service-test' AND token_hash=${digest(token)}`;
      const [row] = await tx<{ started_before_expiry: boolean; expired: boolean }[]>`
        SELECT transaction_timestamp() < expires_at AS started_before_expiry,
          expires_at <= clock_timestamp() AS expired FROM platform._cloud_links
        WHERE package='links-service-test' AND token_hash=${digest(token)}`;
      expect(row).toEqual({ started_before_expiry: true, expired: true });
      expect(await store.peek(token, { purpose: "portal.login" }, { tx })).toEqual(invalid);
      expect(await store.redeem(token, { purpose: "portal.login" }, { tx })).toEqual(invalid);
    });
  });

  test("creation and redemption join domain transactions and roll back together", async () => {
    const { token } = await store.create({ purpose: "login", subject: "customer", ttl: 60 });
    await expect(
      sql.begin(async (tx) => {
        expect((await store.redeem(token, { purpose: "login" }, { tx })).ok).toBe(true);
        await tx`CREATE TEMP TABLE link_session (subject text) ON COMMIT DROP`;
        await tx`INSERT INTO link_session VALUES ('customer')`;
        throw new Error("domain write failed");
      }),
    ).rejects.toThrow("domain write failed");
    expect((await store.redeem(token, { purpose: "login" })).ok).toBe(true);
    await expect(
      sql.begin(async (tx) => {
        await store.create({ purpose: "invite", subject: "rollback", ttl: 900 }, { tx });
        throw new Error("rollback create");
      }),
    ).rejects.toThrow("rollback create");
    const [row] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM platform._cloud_links WHERE package='links-service-test' AND purpose='invite'`;
    expect(row?.count).toBe(0);
  });

  test("apps in one resolved package create and redeem links in their own Bun transactions", async () => {
    bindProcessApplicationId("invoices-test", [], "links-service-test");
    const created = await sql.begin(async (tx) => links.create({ purpose: "portal.login", subject: "customer", ttl: 900 }, { tx }));
    clearProcessApplicationId();
    bindProcessApplicationId("website-test", [], "links-service-test");
    await expect(
      sql.begin(async (tx) => {
        expect(await links.peek(created.token, { purpose: "portal.login" }, { tx })).toMatchObject({
          ok: true,
          data: { subject: "customer" },
        });
        expect(await links.redeem(created.token, { purpose: "portal.login" }, { tx })).toMatchObject({
          ok: true,
          data: { subject: "customer" },
        });
        throw new Error("website rollback");
      }),
    ).rejects.toThrow("website rollback");
    expect((await sql.begin(async (tx) => links.redeem(created.token, { purpose: "portal.login" }, { tx }))).ok).toBe(true);
    await expect(
      sql.begin(async (tx) => {
        await links.create({ purpose: "portal.login", subject: "rolled-back", ttl: 900 }, { tx });
        throw new Error("creation rollback");
      }),
    ).rejects.toThrow("creation rollback");
    const [row] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM platform._cloud_links WHERE package='links-service-test'`;
    expect(row?.count).toBe(1);
  });

  test("cleanup deletes only rows eligible for 24 hours and never exceeds one batch", async () => {
    await sql`INSERT INTO platform._cloud_links (package, token_hash, purpose, subject, created_at, expires_at, used_at)
      SELECT 'links-service-test', 'expired-' || n, 'login', ''::bytea, statement_timestamp() - interval '3 days', statement_timestamp() - interval '25 hours', NULL
      FROM generate_series(1, ${LINK_CLEANUP_BATCH + 1}::int) n`;
    await sql`INSERT INTO platform._cloud_links (package, token_hash, purpose, subject, created_at, expires_at, used_at) VALUES
      ('links-service-test', 'used-old', 'login', ''::bytea, statement_timestamp() - interval '2 days', statement_timestamp() + interval '1 day', statement_timestamp() - interval '25 hours'),
      ('links-service-test', 'expired-recent', 'login', ''::bytea, statement_timestamp() - interval '2 days', statement_timestamp() - interval '23 hours', NULL),
      ('links-service-test', 'used-recent', 'login', ''::bytea, statement_timestamp() - interval '2 days', statement_timestamp() + interval '1 day', statement_timestamp() - interval '23 hours'),
      ('links-service-test', 'active', 'login', ''::bytea, statement_timestamp(), statement_timestamp() + interval '1 day', NULL)`;
    expect(await cleanupLinksBatch(sql)).toBe(LINK_CLEANUP_BATCH);
    expect(await cleanupLinksBatch(sql)).toBe(2);
    expect(await cleanupLinksBatch(sql)).toBe(0);
    const rows = await sql<
      { token_hash: string }[]
    >`SELECT token_hash FROM platform._cloud_links WHERE package='links-service-test' ORDER BY token_hash`;
    expect(rows.map((row) => row.token_hash)).toEqual(["active", "expired-recent", "used-recent"]);
  });
});
