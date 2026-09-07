import type { JobContext, PumpConfig, Sync } from "@k2b/sync";
import { sql } from "bun";
import { freeipa } from "../../server/services/freeipa";
import { getConfiguredExpiryDays } from "../account-model";
import { getFreeIpaConfig } from "../freeipa-config";
import { logger } from "../logging";

const log = logger("auth:ipa:backfill");
const DAY_MS = 24 * 60 * 60 * 1000;

export type IpaBackfillInput = { runId: string; minimumExpiry: string; createdBefore: string } | null;
type IpaBackfillAccount = { userId: string; uid: string; minimumExpiry: string };
type IpaBackfillItem = { key: string; uid: string };

/** Capture one target before accepting work; retries never move it forward. */
export const prepareIpaBackfill = async (runId: string): Promise<IpaBackfillInput> => {
  const config = await getFreeIpaConfig();
  if (!config.enabled) return null;
  if (!config.configured) {
    throw new Error(`FreeIPA is enabled but not fully configured. Missing: ${config.missingSettings.join(", ")}.`);
  }
  const days = await getConfiguredExpiryDays("ipa", "user");
  if (days <= 0) return null;
  const minimumExpiry = new Date(Date.now() + Math.max(days, 7) * DAY_MS);
  minimumExpiry.setUTCHours(23, 59, 59, 0);
  // Preserve Postgres timestamp precision when bounding the finite scan.
  const [snapshot] = await sql<{ created_before: string }[]>`SELECT CURRENT_TIMESTAMP::text AS created_before`;
  if (!snapshot) throw new Error("Could not capture the IPA backfill cutoff");
  return { runId, minimumExpiry: minimumExpiry.toISOString(), createdBefore: snapshot.created_before };
};

export const ipaBackfillConfig: Omit<PumpConfig<IpaBackfillInput, string, IpaBackfillItem>, "dispatch"> = {
  id: "auth:ipa:backfill",
  owner: "core",
  // Keep one bounded producer run at a time; account jobs own directory writes.
  maxActiveRuns: 1,
  dispatchConcurrency: 1,
  leaseMs: 300_000,
  retry: { maxAttempts: 2, backoffMs: [2000, 4000] },
  pull: async ({ input, cursor, limit, signal }) => {
    signal.throwIfAborted();
    if (!input) return { items: [], nextCursor: null };
    const rows = await sql<{ id: string; uid: string }[]>`
      SELECT id, uid
      FROM auth.users
      WHERE provider = 'ipa'
        AND created_at <= ${input.createdBefore}::timestamptz
        AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
        AND (account_expires IS NULL OR account_expires < ${input.minimumExpiry}::timestamptz)
      ORDER BY id
      LIMIT ${limit}
    `;
    signal.throwIfAborted();
    return {
      items: rows.map((row) => ({ key: row.id, uid: row.uid })),
      nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    };
  },
};

export const processIpaBackfillAccount = async ({
  input,
  signal,
}: Pick<JobContext<IpaBackfillAccount>, "input" | "signal">): Promise<void> => {
  signal.throwIfAborted();
  const config = await getFreeIpaConfig();
  // Disabling the provider fails accepted work through the retry policy;
  // it must not checkpoint unfinished directory effects as successful.
  if (!config.enabled || !config.configured) throw new Error("FreeIPA backfill requires an enabled, configured provider");
  const minimumExpiry = new Date(input.minimumExpiry);
  await sql.begin(async (tx) => {
    const [account] = await tx<{ account_expires: Date | null }[]>`
        SELECT account_expires
        FROM auth.users
        WHERE id = ${input.userId}::uuid AND uid = ${input.uid} AND provider = 'ipa'
        FOR UPDATE
      `;
    signal.throwIfAborted();
    // The durable item identifies the original account, never a replacement
    // with the same username. A later local expiry needs no backfill.
    if (!account || (account.account_expires && account.account_expires >= minimumExpiry)) return;
    const ipaSession = await freeipa.session.getServiceSession({ ...config, signal });
    const remote = await freeipa.client.call({
      url: config.url,
      ipaSession,
      method: "user_show",
      args: [input.uid],
      options: { all: true },
      signal,
    });
    if (remote.error) throw new Error(`IPA backfill read failed for ${input.uid}: ${remote.error.message}`);
    const record = remote.result?.result;
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      !("uid" in record) ||
      freeipa.util.str(record.uid) !== input.uid
    ) {
      throw new Error(`IPA backfill received an invalid account for ${input.uid}`);
    }
    const expiryValue = "krbprincipalexpiration" in record ? record.krbprincipalexpiration : undefined;
    const remoteExpiry = freeipa.util.parseGeneralizedTime(expiryValue);
    if (freeipa.util.str(expiryValue) && !remoteExpiry) {
      throw new Error(`IPA backfill received an invalid expiry for ${input.uid}`);
    }
    signal.throwIfAborted();
    const target = remoteExpiry && remoteExpiry >= minimumExpiry ? remoteExpiry : minimumExpiry;
    if (target === minimumExpiry) {
      const response = await freeipa.client.call({
        url: config.url,
        ipaSession,
        method: "user_mod",
        args: [input.uid],
        options: { krbprincipalexpiration: freeipa.util.toGeneralizedTime(target) },
        signal,
      });
      if (response.error) throw new Error(`IPA backfill failed for ${input.uid}: ${response.error.message}`);
    }
    signal.throwIfAborted();
    await tx`
        UPDATE auth.users SET account_expires = ${target} WHERE id = ${input.userId}::uuid
      `;
    await tx`
        INSERT INTO auth.user_ipa_data (user_id, synced_at)
        VALUES (${input.userId}::uuid, now())
        ON CONFLICT (user_id) DO UPDATE SET synced_at = EXCLUDED.synced_at
      `;
    signal.throwIfAborted();
  });
  log.info("IPA expiry backfill account complete", { userId: input.userId, uid: input.uid, minimumExpiry: input.minimumExpiry });
};

export const declareIpaBackfill = (sync: Sync) => {
  const accounts = sync.job<IpaBackfillAccount>({
    id: "auth:ipa:backfill:account",
    owner: "core",
    delivery: { maxInFlight: 1, ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  });
  const pump = sync.pump({
    ...ipaBackfillConfig,
    dispatch: async ({ input, item, signal }) => {
      signal.throwIfAborted();
      if (!input) return;
      await accounts.submit({
        key: `${input.runId}:${item.key}`,
        input: { userId: item.key, uid: item.uid, minimumExpiry: input.minimumExpiry },
      });
    },
  });
  return { pump, accounts };
};
