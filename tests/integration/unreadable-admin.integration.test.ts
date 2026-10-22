import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { z } from "zod";
import { artifactDatabase } from "../../packages/assistant/src/artifacts/database";
import { storageSettings } from "../../packages/assistant/src/artifacts/storage-settings";
import { testIdentity } from "../../packages/assistant/src/artifacts/test-identity";
import { app as assistant } from "../../packages/assistant/src/config";
import { createAdminOutgoingMailRoutes } from "../../packages/cloud/src/api/admin-outgoing-mail";
import { compileCapabilityManifest } from "../../packages/cloud/src/capabilities/testing";
import {
  CONTACT_DIRECTORY_FUNCTIONS,
  ContactDirectoryMatchSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestInputSchema,
  ContactDirectorySuggestionSchema,
} from "../../packages/cloud/src/contracts";
import { crypto } from "../../packages/cloud/src/server/services";
import { audit } from "../../packages/cloud/src/services/audit";
import { session } from "../../packages/cloud/src/services/session";
import { buildProjectedUser } from "../../packages/cloud/src/services/session/user";
import * as settings from "../../packages/cloud/src/services/settings";
import { getAppSecret } from "../../packages/cloud/src/services/settings/crypto";
import { app as mail } from "../../packages/mail/src/config";
import { MAIL_CONTACT_DIRECTORY_SETTING_KEYS } from "../../packages/mail/src/contact-directory-settings";
import {
  type ContactDirectoryDependencies,
  contactDirectoryIssues,
  loadContactDirectoryAdmin,
  saveContactDirectory,
} from "../../packages/mail/src/service/contact-directory";
import { suiteFor } from "../../scripts/fixtures/test-infra";

const suite = suiteFor("database", "valkey");
const keys = [
  "assistant.storage_file_mib",
  "assistant.storage_total_mib",
  "assistant.rsql_url",
  "assistant.rsql_api_token",
  "outgoing_mail.content_retention_days",
  "outgoing_mail.record_retention_days",
  "logs.retention_days",
  ...Object.values(MAIL_CONTACT_DIRECTORY_SETTING_KEYS),
];
const stamp = "2026-01-02T03:04:05.000Z";
const identity = testIdentity("00000000-0000-4000-8000-000000000001");
identity.user.roles = ["admin"];
const user = buildProjectedUser({ id: identity.user.id, provider: "local", profile: "user", effective_admin: true });
const clear = async () => {
  for (const key of keys) await settings.remove(key);
};
const row = async (key: string) =>
  (await sql<{ value: string; updated_at: Date }[]>`SELECT value, updated_at FROM settings.entries WHERE key=${key}`)[0]!;
const unreadable = async (key: string) => {
  const value = await crypto.symmetric.encrypt({
    payload: JSON.stringify("fictional saved value"),
    key: getAppSecret() === "ab".repeat(32) ? "cd".repeat(32) : "ab".repeat(32),
    stretched: false,
  });
  await sql`INSERT INTO settings.entries(key,value,updated_at) VALUES(${key},${value},${stamp}::timestamptz) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`;
  await redis.del(`settings:${key}`);
  return value;
};
const preserved = async (key: string, value: string) => {
  const stored = await row(key);
  expect(stored.value).toBe(value);
  expect(stored.updated_at.toISOString()).toBe(stamp);
};

/** Inject a real concurrent ciphertext change after the first write, before the second row is locked. */
const rejectsWithoutPartialCommit = async (first: string, later: string, save: () => Promise<unknown>) => {
  const before = await row(first);
  const originalSet = settings.set;
  let foreign: string | undefined;
  let firstWritten = false;
  const write = spyOn(settings, "set").mockImplementation(async (key, value, tx, options) => {
    if (key === later) {
      expect(firstWritten).toBe(true);
      foreign = await unreadable(later);
    }
    await originalSet(key, value, tx, options);
    if (key === first) firstWritten = true;
  });
  try {
    await expect(save()).rejects.toMatchObject({ code: "setting_unreadable" });
    expect(firstWritten).toBe(true);
    const after = await row(first);
    expect(after.value).toBe(before.value);
    expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
    expect(foreign).toBeDefined();
    await preserved(later, foreign!);
  } finally {
    write.mockRestore();
  }
};

suite("#1408 application editors preserve unreadable stored settings", () => {
  beforeEach(clear);
  afterAll(clear);
  test("Assistant storage: all keys preflight before writes; partial edits preserve ciphertext", async () => {
    const key = "assistant.storage_total_mib";
    const value = await unreadable(key);
    expect((await storageSettings.read(identity)).unreadable[key]).toBe(true);
    await expect(storageSettings.write({ fileMiB: 64, totalMiB: 250 }, identity)).rejects.toMatchObject({ code: "setting_unreadable" });
    expect((await assistant.settings.read("assistant.storage_file_mib")).stored).toBe("none");
    await preserved(key, value);
    await storageSettings.write({ fileMiB: 64 }, identity);
    await preserved(key, value);
    await storageSettings.write({ totalMiB: 250, replaceUnreadable: [key] }, identity);
    expect(await assistant.settings.read(key)).toEqual({ value: 250, stored: "readable" });
  });
  test("Assistant storage rolls back an earlier key when a later key becomes unreadable after preflight", async () => {
    await settings.set("assistant.storage_file_mib", 50);
    await settings.set("assistant.storage_total_mib", 250);
    await rejectsWithoutPartialCommit("assistant.storage_file_mib", "assistant.storage_total_mib", () =>
      storageSettings.write({ fileMiB: 60, totalMiB: 500 }, identity),
    );
  });
  test("Assistant rsql rolls back settings within its existing advisory transaction", async () => {
    await settings.set("assistant.rsql_url", "");
    await settings.set("assistant.rsql_api_token", "");
    await rejectsWithoutPartialCommit("assistant.rsql_url", "assistant.rsql_api_token", () =>
      artifactDatabase.configure({ url: "", token: "" }, identity),
    );
  });
  test("Assistant database: hidden unreadable token is never replaced by the empty fallback", async () => {
    const key = "assistant.rsql_api_token";
    const value = await unreadable(key);
    await unreadable("assistant.rsql_url");
    expect((await artifactDatabase.settings(identity)).unreadable[key]).toBe(true);
    await expect(artifactDatabase.configure({ token: "" }, identity)).rejects.toMatchObject({ code: "setting_unreadable" });
    await preserved(key, value);
    await artifactDatabase.configure({}, identity);
    await preserved(key, value);
    await artifactDatabase.configure({ url: "", token: "", replaceUnreadable: ["assistant.rsql_url", key] }, identity);
    expect(await assistant.settings.read(key)).toEqual({ value: "", stored: "readable" });
  });
  test("outgoing mail: API returns per-key state, rolls back implicit full saves, and supports partial recovery", async () => {
    const key = "outgoing_mail.record_retention_days";
    const value = await unreadable(key);
    const routes = createAdminOutgoingMailRoutes(async (c, next) => {
      c.set("user", user);
      await next();
    });
    const save = (body: unknown) =>
      routes.request("/retention", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await (await routes.request("/retention")).json()).unreadable[key]).toBe(true);
    const record = spyOn(audit, "record").mockResolvedValue();
    try {
      expect((await save({ contentDays: 30, recordDays: 365 })).status).toBe(409);
      expect((await settings.read("outgoing_mail.content_retention_days")).stored).toBe("none");
      await preserved(key, value);
      expect((await save({ contentDays: 30 })).status).toBe(200);
      await preserved(key, value);
      expect((await save({ recordDays: 365, replaceUnreadable: [key] })).status).toBe(200);
      expect((await settings.read(key)).stored).toBe("readable");
    } finally {
      record.mockRestore();
    }
  });
  test("concurrent partial retention patches cannot commit an invalid pair", async () => {
    await settings.set("outgoing_mail.content_retention_days", 90);
    await settings.set("outgoing_mail.record_retention_days", 365);
    const routes = createAdminOutgoingMailRoutes(async (c, next) => {
      c.set("user", user);
      await next();
    });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Reads remain possible; writes block until both requests have entered their write transaction.
    const holder = sql.begin(async (tx) => {
      await tx`LOCK TABLE settings.entries IN EXCLUSIVE MODE`;
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const originalBegin = sql.begin.bind(sql);
    let entered = 0;
    const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction callback");
      if (++entered === 2) release.resolve();
      return originalBegin(run);
    });
    const record = spyOn(audit, "record").mockResolvedValue();
    try {
      const responses = await Promise.all(
        [{ contentDays: 200 }, { recordDays: 100 }].map((body) =>
          routes.request("/retention", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      const content = await settings.read("outgoing_mail.content_retention_days");
      const record = await settings.read("outgoing_mail.record_retention_days");
      expect(Number(record.value)).toBeGreaterThanOrEqual(Number(content.value));
    } finally {
      release.resolve();
      await holder;
      begin.mockRestore();
      record.mockRestore();
    }
  }, 15000);
  test("Mail contact directory: a submitted unreadable key requires intent before any write", async () => {
    const key = MAIL_CONTACT_DIRECTORY_SETTING_KEYS.suggest;
    const value = await unreadable(key);
    for (const field of ["read", "listWritableBooks", "create"] as const)
      await mail.settings.set(MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field], "");
    const manifest = compileCapabilityManifest("contacts", {
      protocolVersion: 2,
      queries: {
        "contact.suggest": {
          title: "Suggest",
          description: "Fictional",
          input: ContactDirectorySuggestInputSchema,
          data: z.array(ContactDirectorySuggestionSchema).max(10),
          openWorld: false,
          run: async () => ({ ok: true, data: { data: [] } }),
        },
        "contact.resolve": {
          title: "Resolve",
          description: "Fictional",
          input: ContactDirectoryResolveInputSchema,
          data: z
            .object({ items: z.array(ContactDirectoryMatchSchema).max(50), matchedEmails: z.array(z.email().max(320)).max(100) })
            .strict(),
          openWorld: false,
          run: async () => ({ ok: true, data: { data: { items: [], matchedEmails: [] } } }),
        },
      },
    });
    const catalog = { appId: "contacts", appName: "Contacts", appIcon: "", appDescription: "Fictional directory", manifest };
    const deps: Partial<ContactDirectoryDependencies> = {
      isAdmin: async () => true,
      listCatalog: async () => ({ ok: true, data: { protocolVersion: 2, apps: [catalog], page: { hasMore: false } } }),
      getCatalogApp: async () => ({ ok: true, data: catalog }),
    };
    const config = {
      appId: "contacts",
      suggest: "contact.suggest",
      resolve: "contact.resolve",
      read: "",
      listWritableBooks: "",
      create: "",
    };
    const context = { actor: identity.actor, accessSubject: identity.accessSubject, requestId: null };
    const view = await loadContactDirectoryAdmin(context, config, "en", deps);
    expect(view.ok && view.data.unreadable?.[key]).toBe(true);
    await expect(saveContactDirectory(context, config, "en", deps)).rejects.toMatchObject({ code: "setting_unreadable" });
    await preserved(key, value);
    expect((await saveContactDirectory(context, { appId: "contacts" }, "en", deps)).ok).toBe(true);
    await preserved(key, value);
    expect((await saveContactDirectory(context, { suggest: "contact.suggest", replaceUnreadable: [key] }, "en", deps)).ok).toBe(true);
    expect((await mail.settings.read(key)).stored).toBe("readable");
    await rejectsWithoutPartialCommit(MAIL_CONTACT_DIRECTORY_SETTING_KEYS.appId, key, () =>
      saveContactDirectory(context, { appId: "contacts", suggest: "contact.suggest" }, "en", deps),
    );
  });
  test("Mail serializes provider changes with partial patches before reading and catalog validation", async () => {
    const provider = (id: string) => ({
      appId: id,
      appName: id,
      appIcon: "",
      appDescription: "Fictional provider",
      manifest: compileCapabilityManifest(id, {
        protocolVersion: 2,
        queries: {
          [`${id}.suggest`]: {
            title: "Suggest",
            description: "Fictional",
            input: ContactDirectorySuggestInputSchema,
            data: z.array(ContactDirectorySuggestionSchema).max(10),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: [] } }),
          },
          [`${id}.alternate`]: {
            title: "Alternate",
            description: "Fictional",
            input: ContactDirectorySuggestInputSchema,
            data: z.array(ContactDirectorySuggestionSchema).max(10),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: [] } }),
          },
          [`${id}.resolve`]: {
            title: "Resolve",
            description: "Fictional",
            input: ContactDirectoryResolveInputSchema,
            data: z
              .object({ items: z.array(ContactDirectoryMatchSchema).max(50), matchedEmails: z.array(z.email().max(320)).max(100) })
              .strict(),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: { items: [], matchedEmails: [] } } }),
          },
        },
      }),
    });
    const mapping = (id: string) => ({
      appId: id,
      suggest: `${id}.suggest`,
      resolve: `${id}.resolve`,
      read: "",
      listWritableBooks: "",
      create: "",
    });
    const alpha = provider("alpha");
    const beta = provider("beta");
    for (const field of ["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const)
      await settings.set(MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field], mapping("alpha")[field]);
    const validatingAlpha = Promise.withResolvers<void>();
    const releaseAlpha = Promise.withResolvers<void>();
    const context = { actor: identity.actor, accessSubject: identity.accessSubject, requestId: null };
    // Only external authorization/catalog seams are replaced: reads, writes, lock and transaction are production code.
    const deps: Partial<ContactDirectoryDependencies> = {
      isAdmin: async () => true,
      getCatalogApp: async (id) => {
        if (id === "alpha") {
          validatingAlpha.resolve();
          await releaseAlpha.promise;
        }
        return { ok: true, data: id === "alpha" ? alpha : beta };
      },
    };
    const partial = saveContactDirectory(context, { suggest: "alpha.alternate" }, "en", deps);
    await validatingAlpha.promise;
    const switched = saveContactDirectory(context, mapping("beta"), "en", deps);
    const stopPolling = new AbortController();
    const blocked = async () => {
      const deadline = AbortSignal.timeout(10000);
      while (!stopPolling.signal.aborted && !deadline.aborted) {
        const [state] = await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database()
            AND a.query LIKE '%mail.contact-directory-settings%'
          ) AS waiting`;
        if (state?.waiting) return "blocked";
        await Bun.sleep(10);
      }
      if (deadline.aborted) throw new Error("Mapping save never reached the production transaction lock");
      return "stopped";
    };
    const waiting = blocked();
    let ordering: string;
    try {
      // Without serialization beta commits while alpha's stale catalog validation is paused.
      ordering = await Promise.race([waiting, switched.then(() => "committed")]);
    } finally {
      stopPolling.abort();
      releaseAlpha.resolve();
      await Promise.allSettled([partial, switched, waiting]);
    }
    expect(ordering).toBe("blocked");
    expect((await partial).ok).toBe(true);
    expect((await switched).ok).toBe(true);
    const stored = { ...mapping("beta") };
    for (const field of ["appId", ...CONTACT_DIRECTORY_FUNCTIONS] as const)
      stored[field] = (await mail.settings.read(MAIL_CONTACT_DIRECTORY_SETTING_KEYS[field])).value;
    expect(stored).toEqual(mapping("beta"));
    expect(contactDirectoryIssues(stored, beta, "en")).toEqual([]);
    const before = await row(MAIL_CONTACT_DIRECTORY_SETTING_KEYS.suggest);
    expect(await saveContactDirectory(context, { suggest: "alpha.alternate" }, "en", deps)).toMatchObject({
      ok: false,
      status: 400,
      issues: [expect.objectContaining({ field: "suggest", code: "capability_missing" })],
    });
    expect(await row(MAIL_CONTACT_DIRECTORY_SETTING_KEYS.suggest)).toEqual(before);
  }, 15000);
  test("Gateway log retention API exposes unreadable state and requires deliberate replacement", async () => {
    const key = "logs.retention_days";
    const value = await unreadable(key);
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse(stamp));
    const auth = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
    });
    try {
      const { default: routes } = await import("../../packages/gateway-ops/src/observability/logs/api");
      const headers = { "Content-Type": "application/json", Cookie: "session_token=test" };
      expect((await (await routes.request("/settings/retention", { headers })).json()).unreadable).toBe(true);
      expect(
        (await routes.request("/settings/retention", { method: "PUT", headers, body: JSON.stringify({ retentionDays: 14 }) })).status,
      ).toBe(409);
      await preserved(key, value);
      expect(
        (
          await routes.request("/settings/retention", {
            method: "PUT",
            headers,
            body: JSON.stringify({ retentionDays: 14, replaceUnreadable: true }),
          })
        ).status,
      ).toBe(200);
      expect((await settings.read(key)).stored).toBe("readable");
    } finally {
      clock.mockRestore();
      auth.mockRestore();
    }
  });
});
