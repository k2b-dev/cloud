import { api } from "@k2b/cloud/browser";
import type { ApiType } from "./api";

export const apiClient = api.create<ApiType>({ baseUrl: "/api/notifications" });
