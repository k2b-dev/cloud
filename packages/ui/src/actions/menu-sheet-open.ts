import type { MenuSheetOptions } from "./menu-sheet";
import { prefersMenuSheet } from "./phone-sheet";

type MenuSheet = typeof import("./menu-sheet");
let menuSheet: MenuSheet | undefined;

/** Loads the phone menu sheet's code once; a wide screen that never opens a sheet never loads it. */
export const loadMenuSheet = (): Promise<MenuSheet> =>
  menuSheet ? Promise.resolve(menuSheet) : import("./menu-sheet").then((module) => (menuSheet = module));

/** Whether the sheet's code is here, so a sheet opens at once rather than waiting for it. */
export const menuSheetReady = (): boolean => menuSheet !== undefined;

// A phone loads the sheet's code in the background when the menus load, so a tap opens the sheet within the tap.
if (prefersMenuSheet()) loadMenuSheet().catch(() => {});

/**
 * Opens a menu as a bottom sheet: at once when its code is loaded, otherwise as soon as it is. When the code does not
 * load, `unavailable` runs instead, so the opener can show its menu another way; the next open tries again. A failure
 * of the chosen action itself still rejects.
 */
export const openMenuSheet = (options: MenuSheetOptions, unavailable: (error: unknown) => void): Promise<void> =>
  menuSheet ? menuSheet.openMenuSheet(options) : loadMenuSheet().then((module) => module.openMenuSheet(options), unavailable);
