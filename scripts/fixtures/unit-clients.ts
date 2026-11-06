import { afterEach, beforeEach, mock } from "bun:test";
import { realpathSync } from "node:fs";
import { RedisClient, SQL } from "bun";
import * as clients from "../../packages/cloud/src/runtime/clients";

const modulePath = realpathSync(new URL("../../packages/cloud/src/runtime/clients.ts", import.meta.url));

/** Opt-in native test doubles for unit tests that spy on client methods or
 * construct lazy SQL fragments. No platform startup or infrastructure access.
 * Accidental execution reaches only a closed loopback port. */
export const useUnitClients = () => {
  let restore: (() => Promise<void>) | undefined;
  beforeEach(() => {
    const original = { ...clients };
    const sql = new SQL("postgres://127.0.0.1:1/unused_test");
    const redis = new RedisClient("redis://127.0.0.1:1", { autoReconnect: false, enableOfflineQueue: false });
    mock.module(modulePath, () => ({ ...original, sql, redis }));
    restore = async () => {
      mock.module(modulePath, () => original);
      await sql.close();
      redis.close();
    };
  });
  afterEach(async () => {
    await restore?.();
    restore = undefined;
  });
};
