import type { accountIdentities } from "@k2b/cloud/services";
import { z } from "zod";
import type { HomeProvisioningState, HomeProvisioningStatus, OperationResult } from "../contracts";
import type { NewBinding } from "../data/bases";
import { HOME_PROVISIONING_PAGE_SIZE, type homeProvisioning } from "../data/home-provisioning";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { basePath } from "./paths";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Dependencies = {
  identities: Pick<typeof accountIdentities, "provisioningUsers" | "provisioningIdentity">;
  store: typeof homeProvisioning;
  readConfiguration: typeof readConfiguration;
  provision: (config: Config, base: NewBinding, actorId: null, actorName: string) => Promise<OperationResult>;
  lock: <T>(run: () => Promise<T>) => Promise<T>;
  now?: () => number;
};
export function createHomeProvisioning(deps: Dependencies) {
  const now = deps.now ?? (() => performance.now());
  async function ensure(userId: string, input: { eventId?: string; signal?: AbortSignal } = {}) {
    z.uuid().parse(userId);
    input.signal?.throwIfAborted();
    const existing = await deps.store.get(userId);
    let username: string | null = null;
    let area: HomeProvisioningStatus["area"] = existing?.area ?? "cloud";
    const record = (state: HomeProvisioningState, operationId: string | null = null, errorCode: string | null = null) =>
      deps.store.set({ userId, username, area, state, operationId, eventId: input.eventId ?? null, errorCode });
    try {
      const page = await deps.identities.provisioningUsers({ id: userId });
      const user = page.items[0];
      if (!user) return record("inactive");
      username = user.username;
      area = user.provider === "ipa" ? "freeipa" : "cloud";
      if (existing?.state === "done" && existing.area === area) return existing;
      if (area === "freeipa" && !user.posix) return record("posix_incomplete");
      const config = await deps.readConfiguration();
      const target = config[area];
      if (config.unreadable) return record("not_configured");
      if (area === "freeipa" && !target.autoCreate) return record("auto_create_off");
      const available = area === "freeipa" ? page.availability.freeipaEnabled : page.availability.localLinuxEnabled;
      if (!target.enabled || !config.url || !config.token || !available) return record("not_configured");
      if (!target.autoCreate) return record("auto_create_off");
      if (!user.posix) return record("posix_incomplete");
      let posix = user.posix;
      if (area === "freeipa") {
        const signal = AbortSignal.timeout(5_000);
        const current = await deps.identities.provisioningIdentity({
          kind: "users",
          provider: "ipa",
          name: user.username,
          identityId: user.id,
          signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
        });
        input.signal?.throwIfAborted();
        if (
          current.state !== "present" ||
          !current.eligible ||
          current.identity.name !== user.username ||
          (current.identity.id !== null && current.identity.id !== user.id) ||
          current.identity.uidNumber !== user.posix.uidNumber ||
          current.identity.gidNumber !== user.posix.primaryGidNumber
        ) {
          return record("posix_incomplete");
        }
        posix = { uidNumber: current.identity.uidNumber, primaryGidNumber: current.identity.gidNumber };
      }
      input.signal?.throwIfAborted();
      const operation = await deps.provision(
        config,
        {
          area,
          kind: "users",
          identity_id: user.id,
          identity_name: user.username,
          root: target.root,
          path: basePath(config, { area, kind: "users", name: user.username }),
          uid_number: area === "freeipa" ? posix.uidNumber : null,
          gid_number: area === "freeipa" ? posix.primaryGidNumber : null,
        },
        null,
        "automatic-policy",
      );
      if (operation.state !== "complete") throw new FilesError("operation_pending", 409);
      return await record("done", operation.id);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      await record("failed", null, error instanceof FilesError ? error.code : "provisioning_failed");
      throw error;
    }
  }
  return {
    ensure,
    async reconcile(input: { signal?: AbortSignal; heartbeat?: () => Promise<void> } = {}) {
      return deps.lock(async () => {
        input.signal?.throwIfAborted();
        // Half the maintenance scheduler's 60-second acknowledgement window. Finish in-flight effects before yielding.
        const deadline = now() + 30_000;
        const cursor = await deps.store.cursor();
        const totals = { processed: 0, done: 0, pending: 0, failed: 0, nextCursor: cursor.after_id };
        await deps.store.start();
        try {
          const page = await deps.identities.provisioningUsers({ after: cursor.after_id ?? undefined });
          // The source is bounded too; this guard also bounds adapters supplied by callers.
          const users = page.items.slice(0, HOME_PROVISIONING_PAGE_SIZE);
          for (const user of users) {
            input.signal?.throwIfAborted();
            if (now() >= deadline) break;
            await deps.store.renew();
            await input.heartbeat?.();
            input.signal?.throwIfAborted();
            if (now() >= deadline) break;
            try {
              const result = await ensure(user.id, input);
              if (result.state === "done") totals.done++;
              else totals.pending++;
            } catch {
              input.signal?.throwIfAborted();
              totals.failed++;
            }
            // Failed users remain visible and retry on the next full pass; they cannot starve later users.
            await deps.store.advance(user.id, cursor.revision);
            totals.processed++;
            totals.nextCursor = user.id;
          }
          if (totals.processed === users.length && users.length === page.items.length) {
            await deps.store.advance(page.nextCursor, cursor.revision);
            totals.nextCursor = page.nextCursor;
          }
          return totals;
        } finally {
          await deps.store.finish({ processed: totals.processed, done: totals.done, pending: totals.pending, failed: totals.failed });
        }
      });
    },
  };
}
