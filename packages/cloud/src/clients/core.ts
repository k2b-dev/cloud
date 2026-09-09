/**
 * Typed client for the core platform API.
 *
 * Apps that need to call core endpoints (`/api/auth/*`, `/api/me/*`,
 * `/api/admin/lifecycle/*`, `/api/accounts/entities`) import this client
 * instead of constructing their own — the type stays in lockstep with the
 * actual route definitions in `@k2b/cloud/api`.
 */

import type { CoreApiType } from "../api";
import { api } from "../server/api-client";

export const coreClient = api.create<CoreApiType>({ baseUrl: "/api" });

/**
 * Alias for islands that already use the conventional name `apiClient`.
 * Both names refer to the same client; use whichever fits the call site.
 */
export const apiClient = coreClient;
export type { CoreApiType };
