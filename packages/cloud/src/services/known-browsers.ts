import type { SQL } from "bun";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { env } from "../config/env";
import { type BrowserCode, type OsCode, truncateUtf8 } from "../server/request-context";

export const KNOWN_BROWSER_LIMITS = {
  retentionDays: 90,
  browsersPerAccount: 100,
  countriesPerAccount: 50,
  introDays: 14,
  cleanupBatch: 1000,
  cleanupBatchesPerRun: 10,
} as const;
const DAY_MS = 86_400_000;
const cutoffAt = (now: Date) => new Date(now.getTime() - KNOWN_BROWSER_LIMITS.retentionDays * DAY_MS);
const cookieName = (development: boolean) => (development ? "cloud_browser" : "__Host-cloud_browser");
const validCookie = (value: string | undefined): value is string =>
  value !== undefined && value.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(value);

export const readBrowserCookie = (c: Context, development = env.IS_DEVELOPMENT): string | null => {
  const value = getCookie(c, cookieName(development));
  return validCookie(value) ? value : null;
};
export const newBrowserCookie = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const setBrowserCookie = (c: Context, value: string, development = env.IS_DEVELOPMENT): void => {
  setCookie(c, cookieName(development), value, {
    httpOnly: true,
    secure: !development,
    sameSite: "Strict",
    path: "/",
    maxAge: KNOWN_BROWSER_LIMITS.retentionDays * 86_400,
  });
};

/** SHA-256 over canonical UUID text followed immediately by the cookie text; stored as raw bytea. */
export const browserHash = (userId: string, cookie: string): Buffer =>
  new Bun.CryptoHasher("sha256").update(userId.toLowerCase()).update(cookie).digest();

type SignIn = {
  userId: string;
  cookie: string;
  browser: BrowserCode;
  os: OsCode;
  country: string | null;
  city: string | null;
  now: Date;
};

/** Caller holds the existing session issuance lock on this account's auth.users row. */
export const rememberSignIn = async (tx: SQL, input: SignIn): Promise<void> => {
  const { userId, cookie, browser, os, now } = input;
  const country = input.country?.length === 2 && /^[A-Z]{2}$/.test(input.country) ? input.country : null;
  const city = input.city === null ? null : truncateUtf8(input.city, 96);
  const cutoff = cutoffAt(now);
  await tx`
    INSERT INTO auth.known_browsers (user_id, browser_hash, browser, os, country, city, first_seen_at, last_seen_at)
    VALUES (${userId}::uuid, ${browserHash(userId, cookie)}, ${browser}, ${os}, ${country}, ${city}, ${now}, ${now})
    ON CONFLICT (user_id, browser_hash) DO UPDATE SET
      browser = EXCLUDED.browser, os = EXCLUDED.os, country = EXCLUDED.country, city = EXCLUDED.city,
      last_seen_at = EXCLUDED.last_seen_at,
      first_seen_at = CASE WHEN known_browsers.last_seen_at <= ${cutoff} THEN EXCLUDED.first_seen_at ELSE known_browsers.first_seen_at END,
      notified_at = CASE WHEN known_browsers.last_seen_at <= ${cutoff} THEN NULL ELSE known_browsers.notified_at END
  `;
  await tx`
    DELETE FROM auth.known_browsers WHERE user_id = ${userId}::uuid AND (
      last_seen_at <= ${cutoff} OR id IN (
        SELECT id FROM auth.known_browsers WHERE user_id = ${userId}::uuid
        ORDER BY last_seen_at DESC, id DESC OFFSET ${KNOWN_BROWSER_LIMITS.browsersPerAccount}
      )
    )
  `;
  if (country) {
    await tx`
      INSERT INTO auth.sign_in_countries (user_id, country, last_seen_at) VALUES (${userId}::uuid, ${country}, ${now})
      ON CONFLICT (user_id, country) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    `;
    await tx`
      DELETE FROM auth.sign_in_countries WHERE user_id = ${userId}::uuid AND (
        last_seen_at <= ${cutoff} OR country IN (
          SELECT country FROM auth.sign_in_countries WHERE user_id = ${userId}::uuid
          ORDER BY last_seen_at DESC, country OFFSET ${KNOWN_BROWSER_LIMITS.countriesPerAccount}
        )
      )
    `;
    await tx`UPDATE auth.device_trust_state SET geoip_since = ${now} WHERE id = true AND geoip_since IS NULL`;
  }
};

export const findBrowser = async (
  db: SQL,
  { userId, cookie, now }: { userId?: string | null; cookie: string | null; now: Date },
): Promise<{ firstSeenAt: Date } | null> => {
  const id = userId ?? crypto.randomUUID();
  const [row] = await db<{ first_seen_at: Date }[]>`
    SELECT first_seen_at FROM auth.known_browsers
    WHERE user_id = ${id}::uuid AND browser_hash = ${browserHash(id, cookie ?? newBrowserCookie())} AND last_seen_at > ${cutoffAt(now)}
  `;
  return userId && cookie && row ? { firstSeenAt: row.first_seen_at } : null;
};

export const countrySeen = async (
  db: SQL,
  { userId, country, now }: { userId?: string | null; country: string | null; now: Date },
): Promise<boolean> => {
  const [row] = await db<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM auth.sign_in_countries
      WHERE user_id = ${userId ?? crypto.randomUUID()}::uuid AND country = ${country} AND last_seen_at > ${cutoffAt(now)}) AS present
  `;
  return Boolean(userId && row?.present);
};

export const trustState = async (
  db: SQL,
  now: Date,
): Promise<{ startedAt: Date | null; geoipSince: Date | null; introActive: boolean }> => {
  const [row] = await db<{ started_at: Date; geoip_since: Date | null }[]>`
    SELECT started_at, geoip_since FROM auth.device_trust_state WHERE id = true
  `;
  return {
    startedAt: row?.started_at ?? null,
    geoipSince: row?.geoip_since ?? null,
    introActive: !row || now.getTime() < row.started_at.getTime() + KNOWN_BROWSER_LIMITS.introDays * DAY_MS,
  };
};

export const cleanup = async (
  db: SQL,
  {
    now = new Date(),
    signal,
    batchSize = KNOWN_BROWSER_LIMITS.cleanupBatch,
    maxBatches = KNOWN_BROWSER_LIMITS.cleanupBatchesPerRun,
  }: { now?: Date; signal?: AbortSignal; batchSize?: number; maxBatches?: number } = {},
): Promise<{ browsers: number; countries: number }> => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(maxBatches) || maxBatches < 0)
    throw new Error("Known-browser cleanup requires a positive batch size and a non-negative batch count");
  const cutoff = cutoffAt(now);
  const counts = { browsers: 0, countries: 0 };
  // Cleanup never waits for a sign-in: rows a sign-in holds are skipped (waiting could deadlock with its own
  // eviction of the account's other expired rows), and the outer cutoff re-checks a row refreshed meanwhile.
  // A short batch can therefore mean such a skip; the next run continues the backlog. The batch is a
  // materialized CTE because a locking LIMIT subquery inside IN (...) may run more than once and exceed it.
  for (let batch = 0; batch < maxBatches && !signal?.aborted; batch++) {
    const rows = await db`
      WITH batch AS MATERIALIZED (
        SELECT id FROM auth.known_browsers WHERE last_seen_at <= ${cutoff} ORDER BY last_seen_at LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM auth.known_browsers kb USING batch
      WHERE kb.id = batch.id AND kb.last_seen_at <= ${cutoff} RETURNING kb.id
    `;
    counts.browsers += rows.length;
    if (rows.length < batchSize) break;
  }
  for (let batch = 0; batch < maxBatches && !signal?.aborted; batch++) {
    const rows = await db`
      WITH batch AS MATERIALIZED (
        SELECT user_id, country FROM auth.sign_in_countries WHERE last_seen_at <= ${cutoff} ORDER BY last_seen_at LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM auth.sign_in_countries sc USING batch
      WHERE sc.user_id = batch.user_id AND sc.country = batch.country AND sc.last_seen_at <= ${cutoff} RETURNING sc.user_id
    `;
    counts.countries += rows.length;
    if (rows.length < batchSize) break;
  }
  return counts;
};

/** Core-internal persistence and maintenance; no request surface. */
export const knownBrowsers = { findBrowser, countrySeen, trustState, cleanup };
