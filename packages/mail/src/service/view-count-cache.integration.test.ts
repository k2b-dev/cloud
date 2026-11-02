import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { createSql, redis, sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { ok, unwrap } from "@k2b/stdlib";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess, revokeMailboxAccess, updateMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { loadAggregatedViewScope } from "./folder-display";
import { enqueueMailInvalidation } from "./live";
import { createMailbox } from "./mailboxes";
import * as messages from "./messages";
import { type ConversationViewCounts, getConversationViewCounts } from "./messages";
import { CountRefreshBusy, cachedConversationViewCounts, VIEW_COUNT_MAX_AGE_MS } from "./view-count-cache";
import { queryConversationViewCounts } from "./view-count-query";

const suite = suiteFor("database", "nats", "valkey");
const counts = (value: number): ConversationViewCounts => ({
  needs_action: value,
  mine: value,
  unassigned: value,
  waiting: value,
  done: value,
  snoozed: value,
  send_problems: value,
  recently_active: value,
  kept: value,
});

suite("Mail count cache", () => {
  let context: MailRequestContext;
  let mailboxId: string;
  let userId: string;
  let key = 0;
  const reader = () => `test-${++key}`;
  const invalidate = () => sql.begin((tx) => enqueueMailInvalidation(tx, { mailboxId }));
  beforeAll(async () => {
    const uid = `count-cache-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Count cache', false) RETURNING id`;
    userId = row!.id;
    const user: User = {
      id: userId,
      uid,
      provider: "local",
      profile: "user",
      displayName: "Count cache",
      givenname: "Count",
      sn: "Cache",
      mail: null,
      roles: ["user"],
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroupIds: [],
      memberofGroup: [],
      manages: [],
      managesGroupIds: [],
    };
    context = { actor: { kind: "user", user }, accessSubject: { type: "user", userId } };
    mailboxId = unwrap(await createMailbox(context, { name: uid })).id;
  });
  afterEach(() => setSystemTime());
  afterAll(async () => {
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  test("the HTTP workspace survives a cold fill beyond the normal idle timeout and restores it", async () => {
    if (context.actor.kind !== "user") throw new Error("Expected person");
    const user = context.actor.user;
    const auth = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    const delayedCounts = spyOn(messages, "getConversationViewCounts").mockImplementation(async () => {
      await Bun.sleep(13_000);
      return ok(counts(0));
    });
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const timeouts: number[] = [];
    const server = Bun.serve({
      port: 0,
      idleTimeout: 10,
      fetch: (request, server) =>
        api.fetch(request, {
          timeout: (request: Request, seconds: number) => {
            timeouts.push(seconds);
            server.timeout(request, seconds);
          },
        }),
    });
    try {
      const href = `/app/mail/${mailbox!.short_id}`;
      const response = await fetch(
        new URL(`/mailboxes/${mailbox!.short_id}/workspace-route?${new URLSearchParams({ href })}`, server.url),
        {
          headers: { authorization: "Bearer count-timeout-test", "x-forwarded-for": uniqueCallerAddress() },
          signal: AbortSignal.timeout(25_000),
        },
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(timeouts).toEqual([40, 10]);
      delayedCounts.mockRejectedValue(new CountRefreshBusy("Mailbox counts are still refreshing; retry the request"));
      const busy = await fetch(new URL(`/mailboxes/${mailbox!.short_id}/workspace-route?${new URLSearchParams({ href })}`, server.url), {
        headers: { authorization: "Bearer count-timeout-test", "x-forwarded-for": uniqueCallerAddress() },
      });
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "MAIL_COUNTS_REFRESHING" });
      expect(timeouts).toEqual([40, 10, 40, 10]);
    } finally {
      await server.stop(true);
      delayedCounts.mockRestore();
      auth.mockRestore();
    }
  }, 30_000);
  test("a one-connection count transaction reads its own folder scope without a nested connection", async () => {
    const pool = createSql({ max: 1 });
    try {
      await pool.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2s'`;
        const [resource] = await tx<
          { id: string }[]
        >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
          VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active') RETURNING id`;
        const [folder] = await tx<
          { id: string }[]
        >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, display, sync_status)
          VALUES (${newShortId()}, ${resource!.id}::uuid, 'scope-test', 'Scope test', 'other', 'folder_only', 'current') RETURNING id`;
        const [conversation] = await tx<{ id: string }[]>`
          INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
          VALUES (${newShortId()}, ${mailboxId}::uuid, 'Assigned pool guard', 'Reader', '2026-10-01T00:00:00Z', 'needs_action') RETURNING id
        `;
        await tx`INSERT INTO mail.conversation_assignees (conversation_id, user_id)
          VALUES (${conversation!.id}::uuid, ${userId}::uuid)`;
        const scope = await loadAggregatedViewScope([mailboxId], tx);
        expect(scope.isolatedFolderIds).toContain(folder!.id);
        expect(
          await queryConversationViewCounts(
            { mailboxId, currentUserId: userId, visibility: { scope: "mailbox", permission: "admin" } },
            tx,
          ),
        ).toEqual(counts(0));
      });
    } finally {
      await pool.close();
    }
  });
  test("publishes a completed snapshot even when Valkey lost its lease", async () => {
    const ownReader = reader();
    const send = redis.send.bind(redis);
    let key = "";
    const spy = spyOn(redis, "send").mockImplementation((name, args) => {
      if (name === "GET" && args[0]?.includes(Buffer.from(ownReader).toString("base64url"))) key = args[0];
      return send(name, args);
    });
    try {
      expect(
        await cachedConversationViewCounts({
          mailboxId,
          reader: ownReader,
          load: async () => {
            await redis.send("DEL", [`${key}:fill`]);
            return counts(6);
          },
        }),
      ).toEqual(counts(6));
      expect(await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(99) })).toEqual(counts(6));
    } finally {
      spy.mockRestore();
    }
  });
  test("isolates readers and coalesces concurrent misses", async () => {
    const ownReader = reader();
    let calls = 0;
    const load = async () => {
      calls++;
      await Bun.sleep(30);
      return counts(7);
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cachedConversationViewCounts({ mailboxId, reader: ownReader, load })),
    );
    expect(results).toEqual(Array.from({ length: 20 }, () => counts(7)));
    expect(calls).toBe(1);
    expect(await cachedConversationViewCounts({ mailboxId, reader: reader(), load: async () => counts(2) })).toEqual(counts(2));
    expect(await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(99) })).toEqual(counts(7));
  });
  test("uses the distributed fill lease, rather than starting another computation", async () => {
    const ownReader = reader();
    let key = "";
    const send = redis.send.bind(redis);
    const spy = spyOn(redis, "send").mockImplementation((name, args) => {
      if (name === "GET" && args[0]?.includes(Buffer.from(ownReader).toString("base64url"))) key = args[0];
      return send(name, args);
    });
    try {
      await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(1) });
    } finally {
      spy.mockRestore();
    }
    expect(key).not.toBe("");
    await redis.send("DEL", [key]);
    await redis.send("SET", [`${key}:fill`, "other-process", "PX", "10000"]);
    let calls = 0;
    const result = cachedConversationViewCounts({
      mailboxId,
      reader: ownReader,
      load: async () => {
        calls++;
        return counts(99);
      },
    });
    await Bun.sleep(100);
    await redis.send("SET", [key, JSON.stringify({ at: Date.now(), counts: counts(3) }), "PX", "30000"]);
    try {
      expect(await result).toEqual(counts(3));
      expect(calls).toBe(0);
    } finally {
      await redis.send("DEL", [key, `${key}:fill`]);
    }
  });
  test("a slow owner renews its lease past ten seconds and publishes once", async () => {
    const ownReader = reader();
    let key = "";
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const send = redis.send.bind(redis);
    const spy = spyOn(redis, "send").mockImplementation((name, args) => {
      if (name === "GET" && args[0]?.includes(Buffer.from(ownReader).toString("base64url"))) key = args[0];
      return send(name, args);
    });
    let calls = 0;
    const load = async () => {
      calls++;
      started();
      await gate;
      return counts(4);
    };
    const first = cachedConversationViewCounts({ mailboxId, reader: ownReader, load });
    try {
      await ready;
      await Bun.sleep(10_100);
      expect(await redis.send("GET", [`${key}:fill`])).not.toBeNull();
      const second = cachedConversationViewCounts({ mailboxId, reader: ownReader, load });
      finish();
      expect(await first).toEqual(counts(4));
      expect(await second).toEqual(counts(4));
      expect(calls).toBe(1);
    } finally {
      finish();
      await first;
      spy.mockRestore();
    }
  }, 15_000);
  test("bounds computations across different readers below the shared pool size", async () => {
    const limit = Math.max(1, (sql.options.max ?? 10) - 1);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    let full!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      full = resolve;
    });
    const work = Array.from({ length: limit + 3 }, () =>
      cachedConversationViewCounts({
        mailboxId,
        reader: reader(),
        load: async () => {
          peak = Math.max(peak, ++active);
          if (active === limit) full();
          await gate;
          active--;
          return counts(1);
        },
      }),
    );
    try {
      await ready;
      expect(peak).toBe(limit);
    } finally {
      release();
      expect((await Promise.all(work)).every((value) => value.mine === 1)).toBe(true);
    }
    expect(peak).toBe(limit);
  });
  test("live invalidation commits a new version; rollback keeps the previous snapshot", async () => {
    const ownReader = reader();
    const get = (value: number) => cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(value) });
    expect(await get(1)).toEqual(counts(1));
    await expect(
      sql.begin(async (tx) => {
        await enqueueMailInvalidation(tx, { mailboxId });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await get(2)).toEqual(counts(1));
    await invalidate();
    expect(await get(2)).toEqual(counts(2));
  });
  test("invalidating writers do not acquire the shared version lock before commit", async () => {
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE`;
      await tx`SELECT mailbox_id FROM mail.mailbox_read_versions WHERE mailbox_id = ${mailboxId}::uuid FOR UPDATE`;
      locked();
      await gate;
    });
    await ready;
    let enqueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      enqueued = resolve;
    });
    const writer = sql.begin(async (tx) => {
      await enqueueMailInvalidation(tx, { mailboxId });
      await enqueueMailInvalidation(tx, { mailboxId });
      const [row] = await tx<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM mail.pending_read_invalidations WHERE transaction_id = pg_current_xact_id()`;
      expect(row!.count).toBe(1);
      enqueued();
    });
    try {
      expect(await Promise.race([queued.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
    } finally {
      unlock();
      await Promise.all([holder, writer]);
    }
    const [pending] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.pending_read_invalidations`;
    expect(pending!.count).toBe(0);
  });
  test("two-mailbox commits advance both versions and leave no pending rows", async () => {
    const second = unwrap(await createMailbox(context, { name: "Second count version" })).id;
    const versions = () => sql<{ mailbox_id: string; version: string }[]>`SELECT mailbox_id, version::text FROM mail.mailbox_read_versions
      WHERE mailbox_id IN (${mailboxId}::uuid, ${second}::uuid) ORDER BY mailbox_id`;
    try {
      const before = await versions();
      await Promise.all([
        sql.begin(async (tx) => {
          await enqueueMailInvalidation(tx, { mailboxId });
          await enqueueMailInvalidation(tx, { mailboxId: second });
        }),
        sql.begin(async (tx) => {
          await enqueueMailInvalidation(tx, { mailboxId: second });
          await enqueueMailInvalidation(tx, { mailboxId });
        }),
      ]);
      const after = await versions();
      expect(after.length).toBe(2);
      expect(after.every((row) => row.version !== before.find((previous) => previous.mailbox_id === row.mailbox_id)?.version)).toBe(true);
      const [pending] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.pending_read_invalidations`;
      expect(pending!.count).toBe(0);
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${second}::uuid`;
    }
  });
  test("an old computation cannot refill the version after a committed action", async () => {
    const ownReader = reader();
    let finish!: (value: ConversationViewCounts) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const old = cachedConversationViewCounts({
      mailboxId,
      reader: ownReader,
      load: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await ready;
    await invalidate();
    expect(await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(2) })).toEqual(counts(2));
    finish(counts(1));
    await old;
    expect(await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(99) })).toEqual(counts(2));
  });
  test("expires after 30 seconds and quietly refreshes after 15 seconds", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    setSystemTime(at);
    const ownReader = reader();
    const get = (value: number) => cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(value) });
    expect(await get(1)).toEqual(counts(1));
    setSystemTime(at.getTime() + VIEW_COUNT_MAX_AGE_MS);
    expect(await get(2)).toEqual(counts(2));
    setSystemTime(at.getTime() + VIEW_COUNT_MAX_AGE_MS + 15_000);
    expect(await get(3)).toEqual(counts(2));
    // Await a covering read after the background fill (no wall-clock TTL sleep).
    await Bun.sleep(50);
    expect(await get(4)).toEqual(counts(3));
  });
  test("an overloaded owner fails waiters without starting duplicate database work", async () => {
    const ownReader = reader();
    const marker = Buffer.from(ownReader).toString("base64url");
    const send = redis.send.bind(redis);
    let attempted!: () => void;
    const ready = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const spy = spyOn(redis, "send").mockImplementation((name, args) => {
      if (name === "SET" && args[0]?.includes(marker) && args[0].endsWith(":fill")) {
        attempted();
        return Promise.resolve(null);
      }
      return send(name, args);
    });
    const at = new Date("2026-10-01T00:00:00Z").getTime();
    setSystemTime(at);
    let calls = 0;
    const waiting = cachedConversationViewCounts({
      mailboxId,
      reader: ownReader,
      load: async () => {
        calls++;
        return counts(9);
      },
    });
    // Capture rejection without starting Bun's async matcher before advancing the clock.
    const outcome = waiting.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await ready;
      setSystemTime(at + VIEW_COUNT_MAX_AGE_MS + 1);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("still refreshing");
      expect(calls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  test("a failed load releases its lease and the next read can recover", async () => {
    const ownReader = reader();
    await expect(
      cachedConversationViewCounts({
        mailboxId,
        reader: ownReader,
        load: async () => {
          throw new Error("database down");
        },
      }),
    ).rejects.toThrow("database down");
    expect(await cachedConversationViewCounts({ mailboxId, reader: ownReader, load: async () => counts(5) })).toEqual(counts(5));
  });
  test.each(["rejected", "unresponsive"] as const)("Valkey %s falls back to a coalesced authoritative load", async (mode) => {
    const spy = spyOn(redis, "send").mockImplementation(() =>
      mode === "rejected" ? Promise.reject(new Error("Valkey down")) : new Promise<never>(() => {}),
    );
    let calls = 0;
    const ownReader = reader();
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          cachedConversationViewCounts({
            mailboxId,
            reader: ownReader,
            load: async () => {
              calls++;
              await Bun.sleep(30);
              return counts(8);
            },
          }),
        ),
      );
      expect(results.every((result) => result.needs_action === 8)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  test("checks current access before returning a previously cached service result", async () => {
    const uid = `count-cache-reader-${crypto.randomUUID()}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Reader', false) RETURNING id`;
    const userId = row!.id;
    if (context.actor.kind !== "user") throw new Error("Expected person");
    const request: MailRequestContext = {
      actor: { kind: "user", user: { ...context.actor.user, id: userId, uid } },
      accessSubject: { type: "user", userId },
    };
    const grant = unwrap(await grantMailboxAccess({ context, mailboxId, principal: { type: "user", userId }, permission: "read" }));
    try {
      expect((await getConversationViewCounts({ context: request, mailboxId, cached: true })).ok).toBe(true);
      unwrap(await updateMailboxAccess({ context, mailboxId, accessId: grant.id, permission: "read", scope: "assigned" }));
      expect((await getConversationViewCounts({ context: request, mailboxId, cached: true })).ok).toBe(true);
      unwrap(await revokeMailboxAccess({ context, mailboxId, accessId: grant.id }));
      expect(await getConversationViewCounts({ context: request, mailboxId, cached: true })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
