import type { EnvSettingStatus } from "../../contracts/settings-env";
import { SETTINGS, type SettingDef, validateSettingValue } from "./defaults";
import { readStates, type SettingRead } from "./store";

const equal = (a: unknown, b: unknown, jsonText = false): boolean => {
  if (jsonText && typeof a === "string" && typeof b === "string") {
    try {
      return equal(JSON.parse(a), JSON.parse(b));
    } catch {
      return a === b;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.entries(a),
      right = new Map(Object.entries(b));
    return left.length === right.size && left.every(([k, v]) => right.has(k) && equal(v, right.get(k)));
  }
  return a === b;
};

/** Compare locally, return presence and state only, including for secret settings. */
export const envSettingStatus = (def: SettingDef, stored: SettingRead): EnvSettingStatus => {
  let envValue: unknown,
    invalidEnvValue = false,
    envValuePresent = false;
  try {
    const raw = (def.envBootstrap ?? def.envFallback)?.();
    envValuePresent = raw !== undefined;
    if (envValuePresent) {
      const validated = validateSettingValue(def, raw);
      if (validated.ok) envValue = validated.value;
      else invalidEnvValue = true;
    }
  } catch {
    envValuePresent = true;
    invalidEnvValue = true;
  }
  const unreadableStoredValue = stored.stored === "unreadable";
  const storedValuePresent = stored.stored !== "none";
  const conflict =
    envValuePresent && storedValuePresent
      ? invalidEnvValue || unreadableStoredValue
        ? "unknown"
        : equal(envValue, stored.value, def.key === "ai.workflow_budget")
          ? "none"
          : "differs"
      : "none";
  return {
    key: def.key,
    envVariable: def.envVariable ?? null,
    storedValuePresent,
    envValuePresent,
    conflict,
    unreadableStoredValue,
    invalidEnvValue,
    needsAttention: invalidEnvValue || unreadableStoredValue || conflict !== "none" || (envValuePresent && !storedValuePresent),
  };
};

export const readEnvSettingsStatus = async (): Promise<EnvSettingStatus[]> => {
  const defs = SETTINGS.filter((def) => def.envBootstrap || def.envFallback);
  const states = await readStates(defs.map((def) => def.key));
  return defs.map((def) => {
    const state = states.get(def.key);
    if (!state) throw new Error(`Missing stored state for ${def.key}`);
    return envSettingStatus(def, state);
  });
};
