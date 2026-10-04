import { isPwaShellAvailable } from "@k2b/cloud/contracts";
import { getRuntimeContext } from "@k2b/cloud/ssr";

/** The App tab, `/me/app` and the pairing endpoints exist only while the mobile app runs. Needs no database query. */
export const pwaAvailable = (c: { get: (key: "runtime") => unknown }): boolean => isPwaShellAvailable(getRuntimeContext(c).apps);
