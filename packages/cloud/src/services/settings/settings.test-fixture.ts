import { afterAll, beforeAll } from "bun:test";
import { invalidateIdentityRuntimeConfig } from "../identity/runtime-config";
import { read, remove, type SettingRead, set } from "./index";

/** Restore shared settings after this suite, including keys that were not stored. Register before its setup hooks. */
export const preserveTestSettings = (keys: readonly string[]): void => {
  const saved = new Map<string, SettingRead>();
  beforeAll(async () => {
    for (const key of keys) {
      const previous = await read(key);
      if (previous.stored === "unreadable") throw new Error(`Cannot preserve unreadable test setting: ${key}`);
      saved.set(key, previous);
    }
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      for (const [key, previous] of saved) {
        try {
          if (previous.stored === "none") await remove(key);
          else await set(key, previous.value, undefined, { replaceUnreadable: true });
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      invalidateIdentityRuntimeConfig();
    }
    if (failures.length) throw new AggregateError(failures, "Could not restore test settings");
  });
};

/** Declare a suite's settings instead of relying on values left by another integration file. */
export const useTestSettings = (values: Record<string, unknown>): void => {
  preserveTestSettings(Object.keys(values));
  beforeAll(async () => {
    for (const [key, value] of Object.entries(values)) await set(key, value);
    invalidateIdentityRuntimeConfig();
  });
};
