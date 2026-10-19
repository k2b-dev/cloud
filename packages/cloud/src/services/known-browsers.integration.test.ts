import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { env } from "../config/env";
import * as requestContext from "../server/request-context";
import * as sessionTokens from "./identity/session-token";
import * as keyRing from "./identity/key-ring";
import {
  type NewBrowserSignInNotice,
  type NewBrowserSignInNotifier,
  browserHash,
  cleanup,
  maintainNotices,
  countrySeen,
  findBrowser,
  newBrowserCookie,
  rememberSignIn,
  trustState,
} from "./known-browsers";
import { session } from "./session";
import { createTestAppSession } from "./session/session.test-fixture";

const suite = databaseSuite();
const START = new Date("2026-10-18T12:00:00.000Z");
const signIn = { firstName: null, method: "password", device: null, locale: null } as const;
const DAY = 86_400_000;
const cookieName = () => (env.IS_DEVELOPMENT ? "cloud_browser" : "__Host-cloud_browser");
const cookieHeader = (cookie: string) => `${cookieName()}=${cookie}`;
const responseCookie = (response: Response) =>
  response.headers.get("set-cookie")?.match(/(?:^|, )(?:__Host-)?cloud_browser=([A-Za-z0-9_-]{43})/)?.[1];
const users: string[] = [];
const account = async () => {
  const id = crypto.randomUUID();
  users.push(id);
  await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${id}::uuid, ${`known-browser-${id}`}, 'local', 'user')`;
  return id;
};
const login = async (
  userId: string,
  cookie?: string,
  country = "AT",
  city: string | null = "Wien",
  notify: NewBrowserSignInNotifier = async () => {},
) => {
  const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, userId, { method: "password", notify }) }));
  const response = await app.request("/login", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie: cookieHeader(cookie) } : {}),
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0",
      "x-fixture-country": country,
      "x-fixture-city": encodeURIComponent(city ?? ""),
    },
  });
  if (!response.ok) throw new Error(`Fixture sign-in: ${response.status} ${await response.text()}`);
  expect(responseCookie(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return response;
};
// Plain arrays: a Bun SQL result carries `count` and `command`, which toMatchObject compares.
const rows = async (id: string) => [
  ...(await sql<
    {
      id: string;
      browser_hash: Buffer;
      first_seen_at: Date;
      last_seen_at: Date;
      notified_at: Date | null;
      notice: unknown;
      browser: string;
      os: string;
      country: string | null;
      city: string | null;
    }[]
  >`SELECT * FROM auth.known_browsers WHERE user_id = ${id}::uuid ORDER BY last_seen_at, id`),
];
const countries = async (id: string) => [
  ...(await sql<{ country: string; last_seen_at: Date }[]>`
    SELECT country, last_seen_at FROM auth.sign_in_countries WHERE user_id = ${id}::uuid ORDER BY last_seen_at, country
  `),
];
const countryCode = (index: number) => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26));

suite("known browsers at the web session boundary", () => {
  const describe = requestContext.describeRequest;
  let restoreContext: () => void;
  let previousStart: Date;
  beforeEach(async () => {
    setSystemTime(START);
    const [state] = await sql<{ started_at: Date }[]>`SELECT started_at FROM auth.device_trust_state`;
    previousStart = state!.started_at;
    await sql`UPDATE auth.device_trust_state SET started_at = ${new Date(START.getTime() - 15 * DAY)}`;
    // Exercise describeRequest's real browser parsing with a deterministic GeoIP provider.
    const spy = spyOn(requestContext, "describeRequest").mockImplementation((c) =>
      describe(c, {
        geoIp: {
          lookup: () => ({
            cityDatabase: true,
            asnDatabase: false,
            country: c.req.header("x-fixture-country") ?? "AT",
            city: decodeURIComponent(c.req.header("x-fixture-city") ?? "") || null,
            network: null,
          }),
          status: () => ({ city: null, asn: null }),
        },
      }),
    );
    restoreContext = () => spy.mockRestore();
  });
  afterEach(async () => {
    restoreContext();
    await sql`UPDATE auth.device_trust_state SET started_at = ${previousStart}`;
    setSystemTime();
    for (const id of users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("successful sign-ins create then refresh the same browser; sign-out keeps its cookie", async () => {
    const id = await account();
    const first = await login(id);
    const cookie = responseCookie(first)!;
    const [before] = await rows(id);
    expect(before).toMatchObject({
      first_seen_at: START,
      last_seen_at: START,
      browser: "chrome",
      os: "windows",
      country: "AT",
      city: "Wien",
      notified_at: expect.any(Date),
    });
    expect(Buffer.from(before!.browser_hash).equals(browserHash(id, cookie))).toBe(true);
    await sql`UPDATE auth.known_browsers SET notified_at = ${START} WHERE user_id = ${id}::uuid`;
    const later = new Date(START.getTime() + DAY);
    setSystemTime(later);
    const second = await login(id, cookie, "CH", "Zürich");
    expect(responseCookie(second)).toBe(cookie);
    expect(await rows(id)).toMatchObject([
      { first_seen_at: START, last_seen_at: later, notified_at: START, country: "CH", city: "Zürich" },
    ]);
    expect(await countries(id)).toEqual([
      { country: "AT", last_seen_at: START },
      { country: "CH", last_seen_at: later },
    ]);
    const logout = new Hono().post("/logout", async (c) => {
      await session.delete(c);
      return c.body(null, 204);
    });
    const response = await logout.request("/logout", { method: "POST", headers: { cookie: cookieHeader(cookie) } });
    expect(response.headers.get("set-cookie")).not.toContain("cloud_browser");
    expect(await rows(id)).toHaveLength(1);
  });

  test("invalid incoming cookies are replaced only when a session succeeds", async () => {
    const id = await account();
    expect(responseCookie(await login(id, "invalid"))).not.toBe("invalid");
    const app = new Hono().post("/login", async (c) =>
      c.text(await session.create(c, crypto.randomUUID(), { method: "password", notify: async () => {} })),
    );
    const response = await app.request("/login", { method: "POST", headers: { cookie: cookieHeader("invalid") } });
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await rows(id)).toHaveLength(1);
  });

  test("a signer retry preserves the browser option and rolls back the failed issuance", async () => {
    const id = await account();
    const signer = await keyRing.prepareIdentitySigner("session");
    const prepare = spyOn(keyRing, "prepareIdentitySigner")
      .mockResolvedValue(signer)
      .mockResolvedValueOnce({ ...signer, kid: "known-browser-inactive-signer-fixture" });
    const cookie = newBrowserCookie();
    try {
      expect(responseCookie(await login(id, cookie))).toBe(cookie);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(await rows(id)).toHaveLength(1);
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${id}::uuid`).toHaveLength(1);
      expect(await findBrowser(sql, { userId: id, cookie, now: START })).toEqual({ firstSeenAt: START });
    } finally {
      prepare.mockRestore();
    }
  });

  test("two accounts share a cookie but have separate hashes and cascading data", async () => {
    const first = await account(),
      second = await account();
    const cookie = newBrowserCookie();
    expect(responseCookie(await login(first, cookie))).toBe(cookie);
    expect(responseCookie(await login(second, cookie))).toBe(cookie);
    const [a] = await rows(first),
      [b] = await rows(second);
    expect(Buffer.from(a!.browser_hash).equals(Buffer.from(b!.browser_hash))).toBe(false);
    await sql`DELETE FROM auth.users WHERE id = ${first}::uuid`;
    expect(await rows(first)).toHaveLength(0);
    expect(await countries(first)).toHaveLength(0);
    expect(await rows(second)).toHaveLength(1);
  });

  test("reads expire at 90 days without cleanup, and a later sign-in resets first_seen and notified_at", async () => {
    const id = await account();
    const cookie = responseCookie(await login(id))!;
    expect(await findBrowser(sql, { userId: id, cookie, now: START })).toEqual({ firstSeenAt: START });
    expect(await countrySeen(sql, { userId: id, country: "AT", now: START })).toBe(true);
    await sql`UPDATE auth.known_browsers SET notified_at = ${START} WHERE user_id = ${id}::uuid`;
    const boundary = new Date(START.getTime() + 90 * DAY);
    expect(await findBrowser(sql, { userId: id, cookie, now: boundary })).toBeNull();
    expect(await countrySeen(sql, { userId: id, country: "AT", now: boundary })).toBe(false);
    const later = new Date(START.getTime() + 91 * DAY);
    setSystemTime(later);
    expect(await findBrowser(sql, { userId: id, cookie, now: new Date() })).toBeNull();
    expect(await countrySeen(sql, { userId: id, country: "AT", now: new Date() })).toBe(false);
    expect(await rows(id)).toHaveLength(1);
    await login(id, cookie);
    expect(await rows(id)).toMatchObject([{ first_seen_at: later, last_seen_at: later, notified_at: expect.any(Date) }]);
  });

  test("the 101st browser and 51st country evict the oldest; concurrent sign-ins stay bounded", async () => {
    const id = await account();
    const oldest = responseCookie(await login(id, undefined, countryCode(0)))!;
    for (let index = 1; index <= 100; index++) {
      setSystemTime(new Date(START.getTime() + index * 1000));
      await login(id, undefined, countryCode(index % 51));
      if (index === 50) {
        expect(await countries(id)).toHaveLength(50);
        expect(await countrySeen(sql, { userId: id, country: countryCode(0), now: new Date() })).toBe(false);
      }
    }
    expect(await rows(id)).toHaveLength(100);
    expect(await findBrowser(sql, { userId: id, cookie: oldest, now: new Date() })).toBeNull();
    expect(await countries(id)).toHaveLength(50);
    expect(await countrySeen(sql, { userId: id, country: countryCode(50), now: new Date() })).toBe(false);
    // Fresh account: simultaneous first sign-ins must obey both caps under the user-row lock.
    const concurrent = await account();
    await Promise.all(Array.from({ length: 110 }, (_, index) => login(concurrent, undefined, countryCode(index))));
    expect(await rows(concurrent)).toHaveLength(100);
    expect(await countries(concurrent)).toHaveLength(50);
  }, 60_000);

  test("equal timestamps use id descending for browsers and country ascending for countries", async () => {
    const id = await account();
    const cookie = newBrowserCookie();
    const now = START;
    await sql`INSERT INTO auth.known_browsers (id, user_id, browser_hash, browser, os, first_seen_at, last_seen_at)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${id}::uuid,
        decode(lpad(n::text, 64, '0'), 'hex'), 'other', 'other', ${now}, ${now} FROM generate_series(1, 100) n`;
    await sql`INSERT INTO auth.known_browsers (id, user_id, browser_hash, browser, os, first_seen_at, last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000101', ${id}::uuid, ${browserHash(id, cookie)}, 'other', 'other', ${now}, ${now})`;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM auth.users WHERE id = ${id}::uuid FOR UPDATE`;
      await rememberSignIn(tx, { ...signIn, userId: id, cookie, browser: "other", os: "other", country: null, city: null, now });
    });
    expect((await rows(id)).some((row) => row.id === "00000000-0000-4000-8000-000000000001")).toBe(false);
    for (let index = 50; index >= 0; index--) await login(id, cookie, countryCode(index));
    expect((await countries(id)).map((row) => row.country)).toEqual(Array.from({ length: 50 }, (_, index) => countryCode(index)));
  });

  test("invalid countries do not create country rows; cities are independently bounded in UTF-8", async () => {
    const id = await account();
    await login(id, undefined, "at", "界😀".repeat(40));
    expect(await rows(id)).toMatchObject([{ country: null }]);
    expect(Buffer.byteLength((await rows(id))[0]!.city!)).toBeLessThanOrEqual(96);
    expect(await countries(id)).toHaveLength(0);
  });

  test("geoip_since records the first stored country only", async () => {
    // Roll back singleton changes so other suites see the original installation state.
    await sql
      .begin(async (tx) => {
        await tx`UPDATE auth.device_trust_state SET geoip_since = NULL`;
        const id = await account();
        const input = { userId: id, cookie: newBrowserCookie(), browser: "other", os: "other", city: null, now: START } as const;
        await tx`SELECT id FROM auth.users WHERE id = ${id}::uuid FOR UPDATE`;
        await rememberSignIn(tx, { ...signIn, ...input, country: null });
        expect((await trustState(tx, START)).geoipSince).toBeNull();
        await rememberSignIn(tx, { ...signIn, ...input, country: "AT" });
        expect((await trustState(tx, START)).geoipSince).toEqual(START);
        await rememberSignIn(tx, { ...signIn, ...input, country: "CH", now: new Date(START.getTime() + DAY) });
        expect((await trustState(tx, START)).geoipSince).toEqual(START);
        throw new Error("rollback singleton fixture");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback singleton fixture") throw error;
      });
  });

  test("decoy reads query the database, return no match, and write nothing", async () => {
    const id = await account();
    expect(await findBrowser(sql, { userId: null, cookie: newBrowserCookie(), now: START })).toBeNull();
    expect(await findBrowser(sql, { userId: id, cookie: null, now: START })).toBeNull();
    expect(await countrySeen(sql, { userId: undefined, country: "AT", now: START })).toBe(false);
    expect(await rows(id)).toHaveLength(0);
    expect(await countries(id)).toHaveLength(0);
    // A closed real database handle must still fail for a decoy: no early return bypasses the query.
    const closed = new SQL(process.env.DATABASE_URL!);
    await closed.close();
    await expect(findBrowser(closed, { userId: null, cookie: null, now: START })).rejects.toThrow();
    await expect(countrySeen(closed, { country: "AT", now: START })).rejects.toThrow();
  });

  test("mobile issuance writes no known-browser or country row and sets no browser cookie", async () => {
    const id = await account();
    await createTestAppSession(id);
    expect(await rows(id)).toHaveLength(0);
    expect(await countries(id)).toHaveLength(0);
    const app = new Hono().post("/issue", async (c) => {
      const issued = await session.issueInTransaction(c, async (_tx, issue) =>
        issue(id, {
          ttlSeconds: 60,
          // Even an accidentally supplied option cannot turn mobile issuance into web tracking.
          knownBrowser: {
            method: "password",
            device: null,
            locale: null,
            cookie: newBrowserCookie(),
            browser: "other",
            os: "other",
            country: "AT",
            city: "Wien",
          },
        }),
      );
      return c.json({ token: issued.token });
    });
    const response = await app.request("/issue", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await rows(id)).toHaveLength(0);
    expect(await countries(id)).toHaveLength(0);
  });

  test("cleanup skips rows a sign-in holds and keeps the refreshed ones", async () => {
    const id = await account();
    const cookie = newBrowserCookie();
    const expired = new Date(START.getTime() - 91 * DAY);
    // Two expired rows per table: the sign-in refreshes one and evicts the other while the cleanup runs.
    await sql`INSERT INTO auth.known_browsers (user_id, browser_hash, browser, os, first_seen_at, last_seen_at) VALUES
      (${id}::uuid, ${browserHash(id, cookie)}, 'other', 'other', ${expired}, ${expired}),
      (${id}::uuid, ${browserHash(id, newBrowserCookie())}, 'other', 'other', ${expired}, ${expired})`;
    await sql`INSERT INTO auth.sign_in_countries VALUES (${id}::uuid, 'AT', ${expired}), (${id}::uuid, 'CH', ${expired})`;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM auth.users WHERE id = ${id}::uuid FOR UPDATE`;
      await rememberSignIn(tx, { ...signIn, userId: id, cookie, browser: "other", os: "other", country: "AT", city: null, now: START });
      const cleaning = cleanup(sql, { now: START });
      // fixed wait: an upper bound only; a cleanup that waits for this transaction's row locks never settles.
      const settled = await Promise.race([cleaning.then(() => true), Bun.sleep(3_000).then(() => false)]);
      if (!settled) throw new Error("Cleanup waited for the row locks of a sign-in");
    });
    expect(await rows(id)).toMatchObject([{ first_seen_at: START, last_seen_at: START }]);
    expect(await countries(id)).toEqual([{ country: "AT", last_seen_at: START }]);
  });

  test("cleanup deletes at most one batch per table, keeps live rows and catches up later", async () => {
    const id = await account();
    await sql
      .begin(async (tx) => {
        // Isolate the global cleanup from rows left by other integration files, then roll it all back.
        await tx`DELETE FROM auth.known_browsers`;
        await tx`DELETE FROM auth.sign_in_countries`;
        const expired = new Date(START.getTime() - 90 * DAY);
        await tx`SELECT id FROM auth.users WHERE id = ${id}::uuid FOR UPDATE`;
        await rememberSignIn(tx, {
          ...signIn,
          userId: id,
          cookie: newBrowserCookie(),
          browser: "other",
          os: "other",
          country: "ZZ",
          city: null,
          now: START,
        });
        // Seed the backlog after the live sign-in, which evicts expired rows for this account.
        await tx`INSERT INTO auth.known_browsers (user_id, browser_hash, browser, os, first_seen_at, last_seen_at)
        SELECT ${id}::uuid, decode(lpad(n::text, 64, '0'), 'hex'), 'other', 'other', ${expired}, ${expired} FROM generate_series(1, 7) n`;
        for (let n = 0; n < 7; n++) await tx`INSERT INTO auth.sign_in_countries VALUES (${id}::uuid, ${countryCode(n)}, ${expired})`;
        expect(await cleanup(tx, { now: START, batchSize: 3, maxBatches: 1 })).toEqual({ browsers: 3, countries: 3 });
        expect(await cleanup(tx, { now: START, batchSize: 3, maxBatches: 1, signal: AbortSignal.abort() })).toEqual({
          browsers: 0,
          countries: 0,
        });
        expect(await cleanup(tx, { now: START, batchSize: 3, maxBatches: 1 })).toEqual({ browsers: 3, countries: 3 });
        expect(await cleanup(tx, { now: START, batchSize: 3, maxBatches: 1 })).toEqual({ browsers: 1, countries: 1 });
        expect(await tx`SELECT id FROM auth.known_browsers WHERE user_id = ${id}::uuid AND last_seen_at = ${START}`).toHaveLength(1);
        expect(await tx`SELECT country FROM auth.sign_in_countries WHERE user_id = ${id}::uuid AND last_seen_at = ${START}`).toHaveLength(
          1,
        );
        throw new Error("rollback cleanup fixture");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback cleanup fixture") throw error;
      });
  });

  test("introduction browsers are marked done and never announced later", async () => {
    const id = await account();
    await sql`UPDATE auth.device_trust_state SET started_at = ${START}`;
    const notices: NewBrowserSignInNotice[] = [];
    const notify: NewBrowserSignInNotifier = async (notice) => {
      notices.push(notice);
    };
    await login(id, undefined, "AT", "Wien", notify);
    expect(notices).toEqual([]);
    expect(await rows(id)).toMatchObject([{ notified_at: START, notice: null }]);
    setSystemTime(new Date(START.getTime() + 15 * DAY));
    await maintainNotices(sql, notify);
    expect(notices).toEqual([]);
  });

  test("one notice per new browser, including the same row after retention", async () => {
    const id = await account();
    const notices: NewBrowserSignInNotice[] = [];
    const notify: NewBrowserSignInNotifier = async (notice) => {
      notices.push(notice);
    };
    const cookie = responseCookie(await login(id, undefined, "AT", "Wien", notify))!;
    expect(notices).toHaveLength(1);
    const [row] = await rows(id);
    expect(row).toMatchObject({ notified_at: expect.any(Date), notice: null });
    setSystemTime(new Date(START.getTime() + DAY));
    await login(id, cookie, "CH", "Zürich", notify);
    expect(notices).toHaveLength(1);
    setSystemTime(new Date(START.getTime() + 92 * DAY));
    await login(id, cookie, "CH", "Zürich", notify);
    expect(notices).toHaveLength(2);
    expect(notices[1]!.browserId).toBe(notices[0]!.browserId);
    expect(notices[1]!.signedInAt).not.toBe(notices[0]!.signedInAt);
  });

  test("failed handoff leaves the original snapshot for a single catch-up, without PII in the log", async () => {
    const id = await account();
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    let original: NewBrowserSignInNotice | undefined;
    let attempts = 0;
    const fail: NewBrowserSignInNotifier = async (notice) => {
      original ??= notice;
      attempts++;
      // A separate connection sees the family: this handoff runs after COMMIT.
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${id}::uuid`).toHaveLength(1);
      throw new TypeError(`Secret ${id} Wien chrome`);
    };
    try {
      const response = await login(id, undefined, "AT", "Wien", fail);
      expect(response.status).toBe(200);
      expect(warnings).toHaveBeenCalledWith("[known-browsers]", "New-browser notice failed", { error: "TypeError" });
      expect(await rows(id)).toMatchObject([{ notified_at: null, notice: { city: "Wien", country: "AT" } }]);
      setSystemTime(new Date(START.getTime() + DAY));
      await login(id, responseCookie(response), "CH", "Zürich", fail);
      expect(attempts).toBe(1);
      expect(await rows(id)).toMatchObject([
        { country: "CH", city: "Zürich", notified_at: null, notice: { country: "AT", city: "Wien", signedInAt: START.toISOString() } },
      ]);
      const received: NewBrowserSignInNotice[] = [];
      const notify: NewBrowserSignInNotifier = async (notice) => {
        received.push(notice);
      };
      await maintainNotices(sql, notify);
      expect(received.filter((notice) => notice.userId === id)).toEqual([original!]);
      expect(await rows(id)).toMatchObject([{ notified_at: expect.any(Date), notice: null }]);
      await maintainNotices(sql, notify);
      expect(received.filter((notice) => notice.userId === id)).toHaveLength(1);
    } finally {
      warnings.mockRestore();
    }
  });

  test("catch-up is oldest first, bounded, skips invalid and expired snapshots, and continues after failure", async () => {
    const id = await account();
    // Isolate a global maintenance batch and roll it back. Its updates must use the supplied DB.
    const rollback = "rollback notice batch";
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM auth.known_browsers`;
        const snapshot = {
          browser: "chrome",
          os: "macos",
          country: "AT",
          city: "Wien",
          signedInAt: START.toISOString(),
          method: "password",
          device: null,
          locale: "de",
        };
        const ids: string[] = [];
        for (let index = 0; index < 5; index++) {
          const browserId = crypto.randomUUID();
          ids.push(browserId);
          const at = new Date(START.getTime() - (5 - index) * 1000);
          await tx`INSERT INTO auth.known_browsers (id, user_id, browser_hash, browser, os, first_seen_at, last_seen_at, notice)
            VALUES (${browserId}::uuid, ${id}::uuid, ${browserHash(id, newBrowserCookie())}, 'chrome', 'macos', ${at}, ${START}, ${JSON.stringify(snapshot)}::text::jsonb)`;
        }
        const received: string[] = [];
        const notify: NewBrowserSignInNotifier = async (notice) => {
          received.push(notice.browserId);
        };
        expect(await maintainNotices(tx, notify, { batchSize: 3 })).toBe(3);
        expect(received).toEqual(ids.slice(0, 3));
        expect(await maintainNotices(tx, notify, { batchSize: 3 })).toBe(2);
        expect(received).toEqual(ids);
        await tx`UPDATE auth.known_browsers SET notified_at = NULL, notice = ${JSON.stringify(snapshot)}::text::jsonb`;
        const failing: NewBrowserSignInNotifier = async (notice) => {
          if (notice.browserId === ids[0]) throw new Error("retry");
          received.push(notice.browserId);
        };
        expect(await maintainNotices(tx, failing, { batchSize: 3 })).toBe(2);
        expect(await tx`SELECT id FROM auth.known_browsers WHERE id = ${ids[0]!}::uuid AND notified_at IS NULL`).toHaveLength(1);
        await tx`UPDATE auth.known_browsers SET notice = '{"broken":true}'::jsonb WHERE id = ${ids[0]!}::uuid`;
        await tx`UPDATE auth.known_browsers SET last_seen_at = ${new Date(START.getTime() - 91 * DAY)} WHERE id = ${ids[3]!}::uuid`;
        expect(await maintainNotices(tx, notify, { batchSize: 3 })).toBe(1);
        expect(
          await tx`SELECT id FROM auth.known_browsers WHERE id = ${ids[0]!}::uuid AND notified_at IS NOT NULL AND notice IS NULL`,
        ).toHaveLength(1);
        await expect(maintainNotices(tx, notify, { signal: AbortSignal.abort() })).rejects.toThrow();
        throw new Error(rollback);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== rollback) throw error;
    }
  });

  test("a committed first attempt keeps its notice when signing requires a replacement family", async () => {
    const id = await account();
    const signer = await keyRing.prepareIdentitySigner("session");
    // Copy the prepared signer so the fixture cannot change the shared signer cache or real key.
    const firstSigner = { ...signer };
    const prepare = spyOn(keyRing, "prepareIdentitySigner").mockResolvedValue(signer).mockResolvedValueOnce(firstSigner);
    const sign = sessionTokens.signSessionToken;
    const signing = spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(async (...args) => {
      const signed = await sign(...args);
      // Reproduce the inactive-signer check after the first transaction committed.
      firstSigner.kid = "known-browser-revoked-after-commit-fixture";
      setSystemTime(new Date(START.getTime() + 1000));
      return signed;
    });
    const received: NewBrowserSignInNotice[] = [];
    try {
      await login(id, undefined, "AT", "Wien", async (notice) => {
        received.push(notice);
      });
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(received).toHaveLength(1);
      expect(received[0]!.signedInAt).toBe(START.toISOString());
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${id}::uuid`).toHaveLength(2);
      expect(await rows(id)).toMatchObject([{ notified_at: expect.any(Date), notice: null }]);
    } finally {
      signing.mockRestore();
      prepare.mockRestore();
    }
  });

  test("snapshot bounds device bytes and locale length, and stores no identity or name", async () => {
    const id = await account();
    const rollback = "rollback bounded snapshot";
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id = ${id}::uuid FOR UPDATE`;
        const notice = await rememberSignIn(tx, {
          ...signIn,
          userId: id,
          firstName: "Jana",
          cookie: newBrowserCookie(),
          browser: "chrome",
          os: "macos",
          country: "AT",
          city: "Wien",
          now: START,
          method: "cloud_login",
          device: "界😀".repeat(40),
          locale: "x".repeat(36),
        });
        expect(notice).toMatchObject({ userId: id, firstName: "Jana", method: "cloud_login", locale: null });
        expect(Buffer.byteLength(notice!.device!)).toBeLessThanOrEqual(80);
        const [row] = await tx<{ notice: Record<string, unknown> }[]>`SELECT notice FROM auth.known_browsers WHERE user_id = ${id}::uuid`;
        expect(Object.keys(row!.notice).sort()).toEqual(["browser", "city", "country", "device", "locale", "method", "os", "signedInAt"]);
        throw new Error(rollback);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== rollback) throw error;
    }
  });
});
