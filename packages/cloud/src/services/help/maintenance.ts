import { startAppCatalogMaintenance } from "../app-catalogs";

/** Standalone Help maintenance follows registry membership and pending retention deadlines. */
export const startHelpMaintenance = (): (() => Promise<void>) => startAppCatalogMaintenance(["help.corpora"]);
