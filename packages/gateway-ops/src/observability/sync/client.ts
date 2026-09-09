import { api } from "@k2b/cloud/browser";
import type { SyncApiType } from "./api";

export const syncApiClient = api.create<SyncApiType>({ baseUrl: "/api/gateway/sync" });
