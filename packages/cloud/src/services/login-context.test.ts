import { expect, test } from "bun:test";
import { type AppDeviceInbox, type AppLoginContext, AppLoginContextSchema, type AppPendingLogin } from "../contracts/app-approval";
import {
  boundLoginContext,
  buildLoginContext,
  type LoginContextInput,
  loginContextLevel,
  loginContextStorageBytes,
  trimAppLoginResponse,
} from "./login-context";

const now = new Date("2026-10-18T12:00:00.000Z");
const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
const input: LoginContextInput = {
  now,
  request: { browser: "firefox", os: "linux", country: "AT", city: "Vienna", network: "Operator", cookie: null, prefix: null },
  browser: null,
  countries: { seen: false, any: true },
  trust: { introActive: false, geoipSince: before(30) },
};
const context = (): AppLoginContext => AppLoginContextSchema.parse(buildLoginContext(input));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
// Independently render JSONB whitespace; order does not affect length.
const jsonbText = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${jsonbText(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
};

test("Core's level table covers introduction, known browsers and country history", () => {
  const rows = [
    [true, false, true, true, "info"],
    [false, true, false, true, "info"],
    [false, true, true, true, "hint"],
    [false, false, false, true, "hint"],
    [false, false, true, false, "hint"],
    [false, false, true, true, "warn"],
  ] as const;
  for (const [introActive, knownBrowser, newCountry, anyCountry, level] of rows)
    expect(loginContextLevel({ introActive, knownBrowser, newCountry, anyCountry })).toBe(level);
  for (const knownBrowser of [false, true])
    for (const newCountry of [false, true])
      for (const anyCountry of [false, true])
        expect(loginContextLevel({ introActive: true, knownBrowser, newCountry, anyCountry })).toBe("info");
  expect(buildLoginContext({ ...input, trust: { ...input.trust, introActive: true } })).toMatchObject({ level: "info", history: null });
});

test("no GeoIP, descriptions, network hints and coverage dates do not raise the level", () => {
  for (const browser of [null, { firstSeenAt: before(7) }]) {
    for (const changed of [{ request: { ...input.request!, country: null } }, { trust: { introActive: false, geoipSince: null } }])
      expect(buildLoginContext({ ...input, browser, ...changed })).toMatchObject({
        level: browser ? "info" : "hint",
        history: { newCountry: false },
      });
  }
  for (const days of [30, 90, 120]) {
    for (const request of [
      input.request,
      { ...input.request!, browser: "safari" as const, os: "ios" as const, network: "Other operator", prefix: "public prefix" },
    ]) {
      const built = buildLoginContext({ ...input, request, trust: { introActive: false, geoipSince: before(days) } });
      expect(built).toMatchObject({ level: "warn", history: { countriesSince: days < 90 ? before(days).toISOString() : null } });
      expect(boundLoginContext({ ...AppLoginContextSchema.parse(built), sameNetwork: true })).toEqual(built);
    }
  }
  expect(buildLoginContext({ ...input, request: undefined, browser: null })).toMatchObject({
    browser: "other",
    os: "other",
    country: null,
    city: null,
    network: null,
    level: "hint",
  });
  expect(buildLoginContext({ ...input, browser: { firstSeenAt: before(7) }, countries: { seen: true, any: true } })).toMatchObject({
    level: "info",
    history: { knownSince: before(7).toISOString(), newCountry: false },
  });
});

test("names are cleaned and truncated by UTF-8 bytes; JSONB storage stays below its CHECK", () => {
  for (const name of ["界".repeat(32), '"\\'.repeat(48), "😀".repeat(24)]) {
    const built = buildLoginContext({ ...input, request: { ...input.request!, city: name, network: name } });
    expect(built).not.toBeNull();
    expect(AppLoginContextSchema.safeParse(built).success).toBe(true);
    expect(new TextEncoder().encode(jsonbText(built)).length).toBeLessThanOrEqual(512);
    expect(loginContextStorageBytes(built)).toBeGreaterThanOrEqual(new TextEncoder().encode(jsonbText(built)).length);
  }
  const cleaned = buildLoginContext({ ...input, request: { ...input.request!, city: "  A\u202e\n\tB\u2028 C  ", network: " \u200b\n " } });
  expect(cleaned).toMatchObject({ city: "A B C", network: null });
  const truncated = buildLoginContext({ ...input, request: { ...input.request!, city: "界".repeat(40), network: null } });
  expect(truncated?.city).toBe("界".repeat(32));
  const heavy = buildLoginContext({ ...input, request: { ...input.request!, city: '"\\'.repeat(48), network: '"\\'.repeat(48) } });
  expect(heavy).toMatchObject({ city: null, network: null, level: "warn" });
  const original = context();
  // Valid DateTime strings can carry arbitrary fractional precision; even removing
  // both names cannot fit this one. No smaller production storage budget is needed.
  const huge = { ...original, history: { knownSince: `2026-10-18T12:00:00.${"0".repeat(512)}Z`, newCountry: true, countriesSince: null } };
  expect(AppLoginContextSchema.safeParse(huge).success).toBe(true);
  expect(boundLoginContext(huge)).toBeNull();
  expect(boundLoginContext({ ...original, country: "invalid" })).toBeNull();
});

const login = (index: number): AppPendingLogin => ({
  requestId: `ab811792-7476-4a8c-b676-2c6007bb9b5${index}`,
  challenge: "A".repeat(43),
  comparison: "000123",
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 300_000).toISOString(),
  context: context(),
});
test("response budgets pop Actions first, then contexts last-first, preserving every login and the input", () => {
  const action = {
    actionId: login(0).requestId,
    app: { id: "mail", name: "Mail" },
    requester: { app: { id: "assistant", name: "Assistant" }, title: null },
    assurance: "confirm" as const,
    sentence: "Send",
    createdAt: now.toISOString(),
    expiresAt: now.toISOString(),
  };
  const inbox: AppDeviceInbox = {
    logins: [login(0), login(1), login(2)],
    actions: [action, { ...action, sentence: "Second" }],
    moreActions: 1,
    pollAfterSeconds: 5,
  };
  const snapshot = JSON.stringify(inbox);
  const onlyOneAction = { ...inbox, actions: [action], moreActions: 2 };
  expect(trimAppLoginResponse(inbox, bytes(onlyOneAction))).toEqual(onlyOneAction);
  const expected = {
    ...inbox,
    actions: [],
    moreActions: 3,
    logins: inbox.logins.map((row, index) => {
      const { context: _context, ...base } = row;
      return index === 2 ? base : row;
    }),
  };
  const trimmed = trimAppLoginResponse(inbox, bytes(expected));
  expect(trimmed).toEqual(expected);
  expect(trimmed.logins.map((row) => row.requestId)).toEqual(inbox.logins.map((row) => row.requestId));
  expect(JSON.stringify(inbox)).toBe(snapshot);
  const pending = { requests: inbox.logins, pollAfterSeconds: 5 };
  const pendingExpected = { requests: expected.logins, pollAfterSeconds: 5 };
  expect(trimAppLoginResponse(pending, bytes(pendingExpected))).toEqual(pendingExpected);
  const bare = { requests: pending.requests.map(({ context: _context, ...row }) => row), pollAfterSeconds: 5 };
  expect(trimAppLoginResponse(pending, bytes(bare))).toEqual(bare);
});
