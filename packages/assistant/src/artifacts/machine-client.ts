import { api } from "@k2b/cloud/browser";
import type { z } from "zod";
import type { SecretSave } from "./http-contracts";
import type { machineApi } from "./machine-api";
import type { MachineRights } from "./machine-contracts";

const client = api.create<typeof machineApi>({ baseUrl: "/api/assistant/artifacts/machine" });
async function checked<T extends Pick<Response, "ok" | "status" | "json">>(response: T) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
export const machineClient = {
  list: async (id: string, administrative = false) =>
    (
      await checked(await client[":id"].access.$get({ param: { id }, query: { administrative: administrative ? "true" : "false" } }))
    ).json(),
  save: async (id: string, accessId: string, rights: MachineRights, expectedRevision: string | null, administrative = false) =>
    (
      await checked(
        await client[":id"].access[":accessId"].$put({
          param: { id, accessId },
          query: { administrative: administrative ? "true" : "false" },
          json: { rights, expectedRevision },
        }),
      )
    ).json(),
  secrets: async (id: string, administrative = false) =>
    (
      await checked(await client[":id"].secrets.$get({ param: { id }, query: { administrative: administrative ? "true" : "false" } }))
    ).json(),
  saveSecret: async (id: string, value: z.infer<typeof SecretSave>, administrative = false) =>
    (
      await checked(
        await client[":id"].secrets.$put({ param: { id }, query: { administrative: administrative ? "true" : "false" }, json: value }),
      )
    ).json(),
  removeSecret: async (id: string, name: string, revision: string, administrative = false) =>
    (
      await checked(
        await client[":id"].secrets[":name"].$delete({
          param: { id, name },
          query: { administrative: administrative ? "true" : "false" },
          json: { revision },
        }),
      )
    ).json(),
};
