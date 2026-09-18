import { api } from "@k2b/cloud/browser";
import type { PublicApiType } from "../public";
/** Token-scoped routes only; no Cloud session is needed or sent. */
export const publicClient = api.create<PublicApiType>({ baseUrl: "/share/filesv2" });
