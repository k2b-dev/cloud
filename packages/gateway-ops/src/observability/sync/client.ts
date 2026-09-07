import { api } from "@valentinkolb/cloud/browser";
import type { SyncApiType } from "./api";

export const syncApiClient = api.create<SyncApiType>({ baseUrl: "/api/gateway/sync" });
