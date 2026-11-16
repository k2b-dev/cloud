export { type MaintenanceGameTexts, maintenanceGameMessages } from "./messages";
export {
  LAUF_CSS,
  LAUF_SCRIPT,
  type MaintenanceGameController,
  type MaintenanceGameFactory,
  type MaintenanceGameOptions,
} from "./source";

/**
 * Error pages that may offer the waiting game: the generic „not found“ and the generic server failure, and only
 * outside the mobile app and administration. Pages with their own words or their own way out (an app's own error,
 * a login, „access denied“, a failed save or payment) never offer it, because the person has a problem to solve.
 */
export const offersMaintenanceGame = (
  status: number,
  page: { layout?: string; title?: string; description?: string; action?: unknown; path: string },
): boolean =>
  (status === 404 || (status >= 500 && status <= 599)) &&
  page.layout !== "pwa" &&
  page.title === undefined &&
  page.description === undefined &&
  page.action === undefined &&
  !/^\/admin(?:\/|$)/.test(page.path);
