import { SETTINGS } from "./defaults";
import { readStates } from "./store";

export const readAdminSettingsCatalog = async (keys?: readonly string[]) => {
  const defs = keys ? SETTINGS.filter((def) => keys.includes(def.key)) : SETTINGS;
  const states = await readStates(defs.map((def) => def.key));
  return defs.map((def) => {
    const state = states.get(def.key);
    if (!state) throw new Error(`Missing setting state for ${def.key}`);
    return {
      key: def.key,
      kind: def.kind,
      group: def.group,
      stored: state.stored,
      storedValuePresent: state.stored !== "none",
      envBacked: !!(def.envBootstrap || def.envFallback),
    };
  });
};
