import { api } from "@k2b/cloud/browser";
import type { PublicApiType } from "../public";
/** Public routes require no Cloud login; same-origin requests include the share access cookie. */
export const publicClient = api.create<PublicApiType>({ baseUrl: "/share/filesv2" });
