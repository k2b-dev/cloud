import { prefersMenuSheet } from "../actions/phone-sheet";

type Sheet = typeof import("./BottomSheet");
let sheet: Sheet | undefined;
const load = (): Promise<Sheet> => import("./BottomSheet").then((module) => (sheet = module));

/** Loads `BottomSheet` in the background for a sheet that is likely to open soon; a failure waits for that open. */
export const preloadBottomSheet = (): void => {
  if (!sheet) load().catch(() => {});
};
// A phone loads it right away, so the first sheet opens within the tap.
if (prefersMenuSheet()) preloadBottomSheet();

/**
 * Opens a `BottomSheet` that a component shows only on some screens: at once when its code is loaded, otherwise as
 * soon as it is. A wide screen loads it with its first such sheet.
 */
export const withBottomSheet = <T>(open: (module: Sheet) => Promise<T>): Promise<T> => (sheet ? open(sheet) : load().then(open));
