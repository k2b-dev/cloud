/**
 * Paths and ids of the installable mobile app, without schemas, so browser code that runs on every page can test for
 * an app page without loading the contract's validators.
 */
export const PWA_SCOPE = "/pwa/";
export const PWA_AUTH_PATH = "/pwa/_auth";
export const PWA_SERVICE_WORKER_PATH = "/pwa/sw.js";
/** Ids that can never own a part: the shell itself and its own pages `/pwa/settings` and `/pwa/offline`. */
export const PWA_RESERVED_IDS = ["pwa", "settings", "offline"] as const;
/** Whether the app with this id may have a part at `/pwa/<id>`: a plain app id that the shell does not reserve. */
export const isPwaPartId = (id: string): boolean => /^[a-z][a-z0-9-]*$/.test(id) && !PWA_RESERVED_IDS.some((reserved) => reserved === id);
