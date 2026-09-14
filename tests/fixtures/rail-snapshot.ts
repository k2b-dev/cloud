import { spyOn } from "bun:test";
import { defaultRailPreferences } from "../../packages/cloud/src/contracts/rail-preferences";
import * as rail from "../../packages/cloud/src/services/rail-snapshot";

/** Keep app SSR tests on the real rendering seam without loading a user's database state. */
export const stubRailSnapshot = () =>
  spyOn(rail, "readRailSnapshot").mockResolvedValue({ ...defaultRailPreferences(), managedShortcuts: [] });
